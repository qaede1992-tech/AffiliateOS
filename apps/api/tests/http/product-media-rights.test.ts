import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";
import { createInMemoryServices } from "../../src/domain/container.js";
import type { ProductMediaAsset, ProductMediaAssetRepository, ProductMediaRightsAudit, ProductMediaRightsReviewCommand } from "../../src/domain/product-media-ingestion.js";
import type { ProductMediaCandidateRecord, ProductMediaCandidateRepository } from "../../src/domain/product-media-candidate.js";
import { ProductMediaCandidateImportError } from "../../src/domain/product-media-candidate-import.js";

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

const candidate: ProductMediaCandidateRecord = {
  id: "66666666-6666-4666-8666-666666666666", productId, provider: "openverse", candidateHash: "b".repeat(64),
  query: "wireless headphones", title: "Wireless Headphones Model X", imageUrl: "https://images.example.test/model-x.jpg",
  landingPageUrl: "https://source.example.test/model-x", creator: "Photographer", creatorUrl: "https://source.example.test/creator",
  license: "by", licenseVersion: "4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", sourcePublisher: "example",
  identityScore: 78, identityStatus: "review_required", identityReasons: ["Title similarity only; manual review required."],
  reviewStatus: "pending", rightsStatus: "unverified", createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z"
};

function makeApp(
  role: "admin" | "operator" | "viewer" = "admin",
  auditRepositoryConfigured = true,
  importer?: { importApprovedCandidate(productId: string, candidateId: string): Promise<{ asset: ProductMediaAsset; alreadyImported: boolean }> },
  candidateListError?: unknown
) {
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
  let reviewedCandidate = { ...candidate };
  let lastCandidateAuditLimit = 50;
  const candidateReviewAudits: Array<{ id: string; candidateId: string; productId: string; actorId: string; actorRole: "admin"; action: "approve" | "reject"; reason: string; previousStatus: "pending"; newStatus: "approved" | "rejected"; createdAt: string }> = [];
  const candidateRepository: ProductMediaCandidateRepository = {
    async saveMany(rows) { return rows; },
    async listPendingByProduct(id) { if (candidateListError !== undefined) throw candidateListError; return id === productId && reviewedCandidate.reviewStatus === "pending" ? [reviewedCandidate] : []; },
    async review(id, ownerProductId, command) {
      if (id !== candidate.id || ownerProductId !== productId || reviewedCandidate.reviewStatus !== "pending") return undefined;
      const reviewedAt = new Date().toISOString();
      reviewedCandidate = { ...reviewedCandidate, reviewStatus: command.status, reviewedBy: command.actorId, reviewedAt, reviewReason: command.reason, updatedAt: reviewedAt };
      candidateReviewAudits.unshift({ id: "77777777-7777-4777-8777-777777777777", candidateId: candidate.id, productId, actorId: command.actorId, actorRole: "admin", action: command.status === "approved" ? "approve" : "reject", reason: command.reason, previousStatus: "pending", newStatus: command.status, createdAt: reviewedAt });
      return reviewedCandidate;
    },
    async listReviewAudits(ownerProductId, id, limit = 50) {
      lastCandidateAuditLimit = limit;
      return ownerProductId === productId && id === candidate.id ? candidateReviewAudits.slice(0, limit) : [];
    }
  };
  services.productMediaCandidates = candidateRepository;
  if (importer) services.productMediaCandidateImport = importer as never;
  services.productMediaPreviewUrl = async (ownerProductId, id) => ownerProductId === productId && id === assetId ? "https://storage.example.test/signed/product.jpg" : undefined;
  const app = createApp(services, {
    auth: { enabled: false, operatorId: "reviewer-test", role },
    rateLimit: { enabled: false, limit: 100, windowMs: 60_000 }
  });
  return { app, getAsset: () => asset, getReview: () => lastReview, getCandidateAuditLimit: () => lastCandidateAuditLimit };
}

test("admin can list pending product media candidates with provenance and unverified rights", async () => {
  const { app } = makeApp();
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/products/${productId}/media-candidates` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.length, 1);
    assert.equal(response.json().data[0].identityStatus, "review_required");
    assert.equal(response.json().data[0].rightsStatus, "unverified");
    assert.equal(response.json().data[0].landingPageUrl, candidate.landingPageUrl);
  } finally {
    await app.close();
  }
});

test("admin review records an auditable identity decision without verifying publication rights", async () => {
  const { app } = makeApp();
  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-candidates/${candidate.id}/review`,
      payload: { status: "approved", reason: "Visual identity and source page manually checked." }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reviewStatus, "approved");
    assert.equal(response.json().reviewedBy, "reviewer-test");
    assert.equal(response.json().rightsStatus, "unverified");
    const audits = await app.inject({ method: "GET", url: `/api/v1/products/${productId}/media-candidates/${candidate.id}/review-audits` });
    assert.equal(audits.statusCode, 200);
    assert.equal(audits.json().data[0].action, "approve");
    assert.equal(audits.json().data[0].reason, "Visual identity and source page manually checked.");
    assert.equal(getCandidateAuditLimit(), 50);
  } finally {
    await app.close();
  }
});

test("candidate review audit endpoint clamps requested limits", async () => {
  const { app, getCandidateAuditLimit } = makeApp();
  try {
    const oversized = await app.inject({
      method: "GET",
      url: `/api/v1/products/${productId}/media-candidates/${candidate.id}/review-audits?limit=500`
    });
    assert.equal(oversized.statusCode, 200);
    assert.equal(getCandidateAuditLimit(), 50);

    const belowMinimum = await app.inject({
      method: "GET",
      url: `/api/v1/products/${productId}/media-candidates/${candidate.id}/review-audits?limit=0`
    });
    assert.equal(belowMinimum.statusCode, 200);
    assert.equal(getCandidateAuditLimit(), 1);

    const invalid = await app.inject({
      method: "GET",
      url: `/api/v1/products/${productId}/media-candidates/${candidate.id}/review-audits?limit=invalid`
    });
    assert.equal(invalid.statusCode, 200);
    assert.equal(getCandidateAuditLimit(), 50);
  } finally {
    await app.close();
  }
});

test("candidate review rejects a second decision after the pending state is consumed", async () => {
  const { app } = makeApp();
  try {
    const first = await app.inject({ method: "PATCH", url: `/api/v1/products/${productId}/media-candidates/${candidate.id}/review`, payload: { status: "rejected", reason: "Incorrect product identity." } });
    const second = await app.inject({ method: "PATCH", url: `/api/v1/products/${productId}/media-candidates/${candidate.id}/review`, payload: { status: "approved", reason: "Trying to override prior decision." } });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 409);
  } finally {
    await app.close();
  }
});

test("operator cannot approve or reject product media candidates", async () => {
  const { app } = makeApp("operator");
  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-candidates/${candidate.id}/review`,
      payload: { status: "approved", reason: "Operator must not make identity decisions." }
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("operator cannot approve or reject product media candidates", async () => {
  const { app } = makeApp("operator");
  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-candidates/${candidate.id}/review`,
      payload: { status: "approved", reason: "Operator must not approve candidate identity." }
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("operator cannot read pending product media candidates", async () => {
  const { app } = makeApp("operator");
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/products/${productId}/media-candidates` });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});
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

test("product media preflight uses the latest Creator Info duration limit for the sole active TikTok account", async () => {
  const services = createInMemoryServices();
  const tiktokAccount = await services.socialAccounts.create({
    platform: "tiktok",
    accountReference: "creator-preflight-test",
    status: "active"
  });
  services.tiktokCreatorInfo = {
    async getCreatorInfo(account) {
      assert.equal(account.id, tiktokAccount.id);
      return {
        privacyLevelOptions: ["PUBLIC_TO_EVERYONE"],
        commentDisabled: false,
        duetDisabled: false,
        stitchDisabled: false,
        maxVideoPostDurationSec: 120
      };
    }
  };
  const video: ProductMediaAsset = {
    ...initialAsset,
    id: "66666666-6666-4666-8666-666666666666",
    kind: "video",
    objectKey: `products/${productId}/video.mp4`,
    mimeType: "video/mp4",
    byteSize: 1_000_000,
    width: 720,
    height: 1280,
    durationMs: 121_000
  };
  services.productMediaAssets = {
    async findByProductAndHash() { return undefined; },
    async listByProduct(id) { return id === productId ? [video] : []; },
    async save(value) { return value; }
  };
  const app = createApp(services, {
    auth: { enabled: false, operatorId: "reviewer-test", role: "admin" },
    rateLimit: { enabled: false, limit: 100, windowMs: 60_000 }
  });
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/products/${productId}/media-assets` });
    assert.equal(response.statusCode, 200);
    const readiness = response.json().data[0].technicalReadiness.tiktok;
    assert.equal(readiness.status, "not_ready");
    assert.ok(readiness.checks.some((item: { key: string; status: string; detail: string }) =>
      item.key === "creator_duration_limit" && item.status === "fail" && item.detail.includes("120")
    ));
  } finally {
    await app.close();
  }
});

test("product media preflight leaves TikTok duration unknown when Creator Info is unavailable", async () => {
  const services = createInMemoryServices();
  await services.socialAccounts.create({
    platform: "tiktok",
    accountReference: "creator-preflight-outage",
    status: "active"
  });
  services.tiktokCreatorInfo = {
    async getCreatorInfo() { throw new Error("provider unavailable"); }
  };
  const video: ProductMediaAsset = {
    ...initialAsset,
    id: "77777777-7777-4777-8777-777777777777",
    kind: "video",
    objectKey: `products/${productId}/video-outage.mp4`,
    mimeType: "video/mp4",
    byteSize: 1_000_000,
    width: 720,
    height: 1280,
    durationMs: 30_000
  };
  services.productMediaAssets = {
    async findByProductAndHash() { return undefined; },
    async listByProduct(id) { return id === productId ? [video] : []; },
    async save(value) { return value; }
  };
  const app = createApp(services, {
    auth: { enabled: false, operatorId: "reviewer-test", role: "admin" },
    rateLimit: { enabled: false, limit: 100, windowMs: 60_000 }
  });
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/products/${productId}/media-assets` });
    assert.equal(response.statusCode, 200);
    const readiness = response.json().data[0].technicalReadiness.tiktok;
    assert.equal(readiness.status, "review_required");
    assert.ok(readiness.checks.some((item: { key: string; status: string }) =>
      item.key === "creator_duration_limit" && item.status === "unknown"
    ));
  } finally {
    await app.close();
  }
});

test("product media preflight does not guess a TikTok duration limit when multiple active accounts exist", async () => {
  const services = createInMemoryServices();
  await services.socialAccounts.create({
    platform: "tiktok",
    accountReference: "creator-preflight-ambiguous-a",
    status: "active"
  });
  await services.socialAccounts.create({
    platform: "tiktok",
    accountReference: "creator-preflight-ambiguous-b",
    status: "active"
  });
  let creatorInfoCalls = 0;
  services.tiktokCreatorInfo = {
    async getCreatorInfo() {
      creatorInfoCalls += 1;
      return {
        privacyLevelOptions: ["PUBLIC_TO_EVERYONE"],
        commentDisabled: false,
        duetDisabled: false,
        stitchDisabled: false,
        maxVideoPostDurationSec: 120
      };
    }
  };
  const video: ProductMediaAsset = {
    ...initialAsset,
    id: "88888888-8888-4888-8888-888888888888",
    kind: "video",
    objectKey: `products/${productId}/video-ambiguous.mp4`,
    mimeType: "video/mp4",
    byteSize: 1_000_000,
    width: 720,
    height: 1280,
    durationMs: 30_000
  };
  services.productMediaAssets = {
    async findByProductAndHash() { return undefined; },
    async listByProduct(id) { return id === productId ? [video] : []; },
    async save(value) { return value; }
  };
  const app = createApp(services, {
    auth: { enabled: false, operatorId: "reviewer-test", role: "admin" },
    rateLimit: { enabled: false, limit: 100, windowMs: 60_000 }
  });
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/products/${productId}/media-assets` });
    assert.equal(response.statusCode, 200);
    const readiness = response.json().data[0].technicalReadiness.tiktok;
    assert.equal(readiness.status, "review_required");
    assert.equal(creatorInfoCalls, 0);
    assert.ok(readiness.checks.some((item: { key: string; status: string }) =>
      item.key === "creator_duration_limit" && item.status === "unknown"
    ));
  } finally {
    await app.close();
  }
});


test("admin can import an approved product media candidate and the response keeps rights unverified", async () => {
  let importCalls = 0;
  const importer = {
    async importApprovedCandidate(ownerProductId: string, candidateId: string) {
      importCalls += 1;
      assert.equal(ownerProductId, productId);
      assert.equal(candidateId, candidate.id);
      return { asset: { ...initialAsset, sourceCandidateId: candidate.id }, alreadyImported: false } as { asset: ProductMediaAsset; alreadyImported: boolean };
    }
  };
  const { app } = makeApp("admin", true, importer);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/media-candidates/${candidate.id}/import`
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().alreadyImported, false);
    assert.equal(response.json().asset.rightsStatus, "unverified");
    assert.equal(importCalls, 1);
  } finally {
    await app.close();
  }
});

test("operator cannot import product media candidates and importer is never invoked", async () => {
  let importCalls = 0;
  const importer = {
    async importApprovedCandidate() {
      importCalls += 1;
      return { asset: initialAsset, alreadyImported: false };
    }
  };
  const { app } = makeApp("operator", true, importer);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/media-candidates/${candidate.id}/import`
    });
    assert.equal(response.statusCode, 403);
    assert.equal(importCalls, 0);
  } finally {
    await app.close();
  }
});

test("candidate import maps revoked existing asset rights to HTTP 409", async () => {
  const importer = {
    async importApprovedCandidate() {
      throw new ProductMediaCandidateImportError(
        "MEDIA_ASSET_RIGHTS_REVOKED",
        "The existing media asset has revoked publication rights.",
        409
      );
    }
  };
  const { app } = makeApp("admin", true, importer);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/media-candidates/${candidate.id}/import`
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "MEDIA_ASSET_RIGHTS_REVOKED");
  } finally {
    await app.close();
  }
});


test("admin receives a clear 503 when the product media candidates migration is not applied", async () => {
  const missingTable = Object.assign(new Error('relation "product_media_candidates" does not exist'), { code: "42P01" });
  const { app } = makeApp("admin", true, undefined, missingTable);
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/products/${productId}/media-candidates` });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, "PRODUCT_MEDIA_CANDIDATES_SCHEMA_NOT_READY");
  } finally {
    await app.close();
  }
});

test("does not mask unrelated PostgreSQL missing-relation errors", async () => {
  const missingOtherTable = Object.assign(new Error('relation "some_other_table" does not exist'), { code: "42P01" });
  const { app } = makeApp("admin", true, undefined, missingOtherTable);
  try {
    const response = await app.inject({ method: "GET", url: `/api/v1/products/${productId}/media-candidates` });
    assert.equal(response.statusCode, 500);
  } finally {
    await app.close();
  }
});
