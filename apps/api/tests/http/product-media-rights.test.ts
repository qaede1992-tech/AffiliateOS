import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";
import { createInMemoryServices } from "../../src/domain/container.js";
import type { ProductMediaAsset, ProductMediaAssetRepository, ProductMediaRightsAudit, ProductMediaRightsReviewCommand } from "../../src/domain/product-media-ingestion.js";

const productId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";
const initialAsset: ProductMediaAsset = {
  id: assetId,
  productId,
  kind: "image",
  bucket: "affiliate-media",
  objectKey: `products/${productId}/image.webp`,
  mimeType: "image/webp",
  byteSize: 128,
  sha256: "a".repeat(64),
  sourceUrl: "https://cdn.example.test/image.webp",
  sourcePublisher: null,
  rightsStatus: "unverified",
  rightsBasis: null,
  rightsEvidenceUrl: null,
  rightsVerifiedAt: null,
  createdAt: "2026-11-02T00:00:00.000Z"
};

function makeApp(role: "admin" | "operator" | "viewer" = "admin", auditRepositoryConfigured = true) {
  let asset = { ...initialAsset };
  let lastReview: ProductMediaRightsReviewCommand | undefined;
  const auditRows: ProductMediaRightsAudit[] = [];
  const repository: ProductMediaAssetRepository = {
    async findByProductAndHash() { return undefined; },
    async listByProduct(id) { return id === productId ? [asset] : []; },
    async listRightsAudits(ownerProductId, id) { return ownerProductId === productId && id === assetId ? [...auditRows] : []; },
    async save(value) { asset = value; return value; },
    ...(auditRepositoryConfigured ? {
      async reviewRights(id: string, ownerProductId: string, review: ProductMediaRightsReviewCommand) {
        if (id !== assetId || ownerProductId !== productId) return undefined;
        lastReview = review;
        auditRows.unshift({ id: "55555555-5555-4555-8555-555555555555", assetId, productId, actorId: review.actorId, actorRole: review.actorRole, action: review.status === "verified" ? "verify" : "revoke", reason: review.reason, previousRightsStatus: asset.rightsStatus, newRightsStatus: review.status, rightsBasis: review.status === "verified" ? review.rightsBasis ?? null : asset.rightsBasis, rightsEvidenceUrl: review.status === "verified" ? review.rightsEvidenceUrl ?? null : asset.rightsEvidenceUrl, sourcePublisher: review.status === "verified" ? review.sourcePublisher ?? null : asset.sourcePublisher, createdAt: new Date().toISOString() });
        if (review.status === "verified") {
          asset = {
            ...asset,
            rightsStatus: "verified",
            rightsBasis: review.rightsBasis ?? null,
            rightsEvidenceUrl: review.rightsEvidenceUrl ?? null,
            rightsVerifiedAt: new Date().toISOString(),
            sourcePublisher: review.sourcePublisher ?? null
          };
        } else {
          asset = { ...asset, rightsStatus: "revoked" };
        }
        return asset;
      }
    } : {})
  };
  const services = createInMemoryServices();
  services.productMediaAssets = repository;
  services.productMediaPreviewUrl = async (ownerProductId, id) => ownerProductId === productId && id === assetId ? "https://storage.example.test/signed/product.jpg" : undefined;
  const app = createApp(services, {
    auth: { enabled: false, operatorId: "reviewer-test", role },
    rateLimit: { enabled: false, limit: 100, windowMs: 60_000 }
  });
  return { app, getAsset: () => asset, getReview: () => lastReview };
}

test("admin can list product media and verify rights with credential-free HTTPS evidence and a reason", async () => {
  const { app, getAsset, getReview } = makeApp();
  try {
    const listed = await app.inject({ method: "GET", url: `/api/v1/products/${productId}/media-assets` });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().data[0].rightsStatus, "unverified");
    const listedAsset = listed.json().data[0];
    assert.equal(listedAsset.technicalReadiness.instagram.platform, "instagram");
    assert.equal(listedAsset.technicalReadiness.instagram.status, "review_required");
    assert.ok(listedAsset.technicalReadiness.instagram.checks.some((item: { key: string; status: string }) => item.key === "platform_rules" && item.status === "unknown"));
    assert.equal(listedAsset.technicalReadiness.tiktok.platform, "tiktok");
    assert.equal(listedAsset.technicalReadiness.tiktok.status, "review_required");
    assert.ok(listedAsset.technicalReadiness.tiktok.checks.some((item: { key: string; status: string }) => item.key === "dimensions" && item.status === "unknown"));
    // Technical readiness is advisory and must not change the independent rights decision.
    assert.equal(listedAsset.rightsStatus, "unverified");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: {
        status: "verified",
        rightsBasis: "explicit_permission",
        rightsEvidenceUrl: "https://publisher.example.test/permission",
        sourcePublisher: "Publisher Example",
        reason: "Reviewed the written permission for this exact image."
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().rightsStatus, "verified");
    assert.equal(response.json().rightsBasis, "explicit_permission");
    assert.equal(response.json().sourcePublisher, "Publisher Example");
    assert.ok(Date.parse(response.json().rightsVerifiedAt) <= Date.now());
    assert.equal(getAsset().rightsStatus, "verified");
    assert.equal(getReview()?.actorId, "reviewer-test");
    assert.equal(getReview()?.actorRole, "admin");
    assert.equal(getReview()?.reason, "Reviewed the written permission for this exact image.");
  } finally {
    await app.close();
  }
});

test("admin can revoke rights with a reason while preserving provenance", async () => {
  const { app, getAsset } = makeApp();
  try {
    await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: {
        status: "verified",
        rightsBasis: "license",
        rightsEvidenceUrl: "https://publisher.example.test/license",
        sourcePublisher: "Publisher Example",
        reason: "Reviewed the license terms."
      }
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: { status: "revoked", reason: "The license was withdrawn." }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().rightsStatus, "revoked");
    assert.equal(response.json().rightsEvidenceUrl, "https://publisher.example.test/license");
    assert.equal(response.json().rightsVerifiedAt !== null, true);
    assert.equal(getAsset().rightsStatus, "revoked");
  } finally {
    await app.close();
  }
});

test("operator cannot read the review queue or change product media rights", async () => {
  const { app } = makeApp("operator");
  try {
    const listed = await app.inject({ method: "GET", url: `/api/v1/products/${productId}/media-assets` });
    assert.equal(listed.statusCode, 403);
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: { status: "revoked", reason: "Operator attempt." }
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("viewer cannot change product media rights", async () => {
  const { app } = makeApp("viewer");
  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: { status: "revoked", reason: "Viewer attempt." }
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("rights review fails closed when atomic audit storage is unavailable", async () => {
  const { app, getAsset } = makeApp("admin", false);
  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: { status: "revoked", reason: "Audit repository unavailable." }
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, "PRODUCT_MEDIA_RIGHTS_UNAVAILABLE");
    assert.equal(getAsset().rightsStatus, "unverified");
  } finally {
    await app.close();
  }
});

test("rights verification rejects non-HTTPS or credential-bearing evidence, missing reasons, and unknown assets", async () => {
  const { app } = makeApp();
  try {
    const invalidHttp = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: {
        status: "verified",
        rightsBasis: "license",
        rightsEvidenceUrl: "http://publisher.example.test/license",
        sourcePublisher: "Publisher Example",
        reason: "Invalid HTTP evidence."
      }
    });
    assert.equal(invalidHttp.statusCode, 400);

    const credentialBearing = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: {
        status: "verified",
        rightsBasis: "license",
        rightsEvidenceUrl: "https://user:password@publisher.example.test/license",
        sourcePublisher: "Publisher Example",
        reason: "Credential-bearing evidence URL."
      }
    });
    assert.equal(credentialBearing.statusCode, 400);

    const missingReason = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: {
        status: "verified",
        rightsBasis: "license",
        rightsEvidenceUrl: "https://publisher.example.test/license",
        sourcePublisher: "Publisher Example"
      }
    });
    assert.equal(missingReason.statusCode, 400);

    const missingAsset = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/55555555-5555-4555-8555-555555555555/rights`,
      payload: { status: "revoked", reason: "Unknown asset." }
    });
    assert.equal(missingAsset.statusCode, 404);
    assert.equal(missingAsset.json().error, "PRODUCT_MEDIA_ASSET_NOT_FOUND");
  } finally {
    await app.close();
  }
});


test("admin can request a short-lived signed preview for the exact persisted product media asset", async () => {
  const { app } = makeApp("admin");
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/preview`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().url, "https://storage.example.test/signed/product.jpg");
    assert.equal(response.json().expiresInSeconds, 300);
  } finally {
    await app.close();
  }
});

test("operator cannot request private product media previews", async () => {
  const { app } = makeApp("operator");
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/preview`
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});


test("admin can read immutable rights audit history for the exact product media asset", async () => {
  const { app } = makeApp();
  try {
    await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: { status: "verified", rightsBasis: "explicit_permission", rightsEvidenceUrl: "https://publisher.example.test/proof", sourcePublisher: "Publisher", reason: "Permission checked." }
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights-audits`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.length, 1);
    assert.equal(response.json().data[0].action, "verify");
    assert.equal(response.json().data[0].actorId, "reviewer-test");
    assert.equal(response.json().data[0].reason, "Permission checked.");
  } finally {
    await app.close();
  }
});

test("operator cannot read product media rights audit history", async () => {
  const { app } = makeApp("operator");
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights-audits`
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});
