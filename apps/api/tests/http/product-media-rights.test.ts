import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";
import { createInMemoryServices } from "../../src/domain/container.js";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "../../src/domain/product-media-ingestion.js";

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

function makeApp(role: "admin" | "operator" | "viewer" = "operator") {
  let asset = { ...initialAsset };
  const repository: ProductMediaAssetRepository = {
    async findByProductAndHash() { return undefined; },
    async listByProduct(id) { return id === productId ? [asset] : []; },
    async save(value) { asset = value; return value; },
    async updateRights(id, ownerProductId, rights) {
      if (id !== assetId || ownerProductId !== productId) return undefined;
      asset = { ...asset, ...rights };
      return asset;
    }
  };
  const services = createInMemoryServices();
  services.productMediaAssets = repository;
  const app = createApp(services, {
    auth: { enabled: true, token: "rights-review-test-token", operatorId: "reviewer-test", role },
    rateLimit: { enabled: false, limit: 100, windowMs: 60_000 }
  });
  return { app, getAsset: () => asset };
}

test("operator can list product media and verify rights with HTTPS evidence", async () => {
  const { app, getAsset } = makeApp();
  try {
    const listed = await app.inject({ method: "GET", url: `/api/v1/products/${productId}/media-assets` });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().data[0].rightsStatus, "unverified");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: {
        status: "verified",
        rightsBasis: "explicit_permission",
        rightsEvidenceUrl: "https://publisher.example.test/permission",
        sourcePublisher: "Publisher Example"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().rightsStatus, "verified");
    assert.equal(response.json().rightsBasis, "explicit_permission");
    assert.equal(response.json().sourcePublisher, "Publisher Example");
    assert.ok(Date.parse(response.json().rightsVerifiedAt) <= Date.now());
    assert.equal(getAsset().rightsStatus, "verified");
  } finally {
    await app.close();
  }
});

test("operator can revoke rights without deleting the evidence trail", async () => {
  const { app } = makeApp();
  try {
    await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: {
        status: "verified",
        rightsBasis: "license",
        rightsEvidenceUrl: "https://publisher.example.test/license",
        sourcePublisher: "Publisher Example"
      }
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: { status: "revoked" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().rightsStatus, "revoked");
    assert.equal(response.json().rightsEvidenceUrl, "https://publisher.example.test/license");
    assert.equal(response.json().rightsVerifiedAt !== null, true);
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
      payload: { status: "revoked" }
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("rights verification rejects non-HTTPS evidence and unknown assets", async () => {
  const { app } = makeApp();
  try {
    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/${assetId}/rights`,
      payload: {
        status: "verified",
        rightsBasis: "license",
        rightsEvidenceUrl: "http://publisher.example.test/license",
        sourcePublisher: "Publisher Example"
      }
    });
    assert.equal(invalid.statusCode, 400);

    const missing = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${productId}/media-assets/55555555-5555-4555-8555-555555555555/rights`,
      payload: { status: "revoked" }
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error, "PRODUCT_MEDIA_ASSET_NOT_FOUND");
  } finally {
    await app.close();
  }
});
