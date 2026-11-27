import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authorizeProductMediaDelivery } from "../../src/domain/product-media-delivery-authorization.js";
import { createProductMediaDeliveryToken } from "../../src/domain/product-media-delivery-token.js";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "../../src/domain/product-media-ingestion.js";
import type { PublicationDispatchReservation, PublicationDispatchReservationRepository } from "../../src/domain/publication-dispatch-reservation.js";

const assetId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const contentId = "33333333-3333-4333-8333-333333333333";
const reservationId = "44444444-4444-4444-8444-444444444444";
const key = "a1111111-1111-4111-8111-111111111111.jpg";
const bytes = new Uint8Array([1, 2, 3, 4]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const config = { signingKey: "test-signing-key-that-is-at-least-32-bytes", maximumLifetimeSeconds: 300 };

const asset = (): ProductMediaAsset => ({
  id: assetId, productId, kind: "image", bucket: "local-volume", storageBackend: "local_volume",
  objectKey: key, mimeType: "image/jpeg", byteSize: bytes.byteLength, sha256,
  sourceUrl: "https://media.example/image.jpg", sourcePublisher: "Example publisher",
  rightsStatus: "verified", rightsBasis: "license", rightsEvidenceUrl: "https://media.example/license",
  rightsVerifiedAt: new Date(Date.now() - 1000).toISOString(), identityStatus: "verified",
  identityReviewedBy: "admin-1", identityReviewedAt: new Date(Date.now() - 1000).toISOString(),
  identityReviewReason: "Visual product model and distinguishing details match the selected Shopee listing.",
  createdAt: new Date().toISOString()
});

const reservation = (state: PublicationDispatchReservation["state"] = "dispatching"): PublicationDispatchReservation => ({
  id: reservationId, jobId: "55555555-5555-4555-8555-555555555555", contentId,
  provider: "instagram-graph", state, idempotencyKey: "test-idempotency",
  snapshot: { mediaAssetIds: [assetId] }, snapshotHash: "a".repeat(64),
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
});

function token() {
  return createProductMediaDeliveryToken({
    assetId, productId, contentId, reservationId, sha256,
    expiresAt: Math.floor(Date.now() / 1000) + 120
  }, config);
}

function dependencies(assetRow = asset(), reservationRow = reservation()) {
  const assets = { findById: async (id: string) => id === assetId ? assetRow : undefined } as ProductMediaAssetRepository;
  const reservations = { findById: async (id: string) => id === reservationId ? reservationRow : undefined } as PublicationDispatchReservationRepository;
  return { assets, reservations };
}

describe("reservation-bound product media delivery authorization", () => {
  it("returns bytes only for the exact active Instagram reservation and matching hash", async () => {
    const deps = dependencies();
    const result = await authorizeProductMediaDelivery({
      token: token(), tokenConfig: config, ...deps, maximumBytes: 1024,
      readLocal: async (objectKey) => { assert.equal(objectKey, key); return bytes; }
    });
    assert.equal(result.asset.id, assetId);
    assert.deepEqual(result.bytes, bytes);
  });

  it("rejects reservations that have moved beyond provider delivery", async () => {
    const deps = dependencies(asset(), reservation("published"));
    await assert.rejects(() => authorizeProductMediaDelivery({
      token: token(), tokenConfig: config, ...deps, maximumBytes: 1024,
      readLocal: async () => bytes
    }), /reservation is not active/);
  });

  it("allows the provider to fetch media after accepting the container while the signed token remains valid", async () => {
    const deps = dependencies(asset(), reservation("accepted"));
    const result = await authorizeProductMediaDelivery({
      token: token(), tokenConfig: config, ...deps, maximumBytes: 1024,
      readLocal: async () => bytes
    });
    assert.deepEqual(result.bytes, bytes);
  });

  it("rejects an asset whose product identity has not been independently reviewed", async () => {
    const pending = { ...asset(), identityStatus: "pending" as const, identityReviewedBy: null, identityReviewedAt: null, identityReviewReason: null };
    const deps = dependencies(pending);
    await assert.rejects(() => authorizeProductMediaDelivery({
      token: token(), tokenConfig: config, ...deps, maximumBytes: 1024,
      readLocal: async () => bytes
    }), /not authorized/);
  });

  it("rejects an asset whose rights were revoked after token issuance", async () => {
    const revoked = { ...asset(), rightsStatus: "revoked" as const };
    const deps = dependencies(revoked);
    await assert.rejects(() => authorizeProductMediaDelivery({
      token: token(), tokenConfig: config, ...deps, maximumBytes: 1024,
      readLocal: async () => bytes
    }), /not authorized/);
  });

  it("rejects changed file bytes even when the reservation and token are valid", async () => {
    const deps = dependencies();
    await assert.rejects(() => authorizeProductMediaDelivery({
      token: token(), tokenConfig: config, ...deps, maximumBytes: 1024,
      readLocal: async () => new Uint8Array([9, 9, 9])
    }), /integrity verification failed/);
  });

  it("rejects assets not present in the immutable reservation snapshot", async () => {
    const row = { ...reservation(), snapshot: { mediaAssetIds: [] } };
    const deps = dependencies(asset(), row);
    await assert.rejects(() => authorizeProductMediaDelivery({
      token: token(), tokenConfig: config, ...deps, maximumBytes: 1024,
      readLocal: async () => bytes
    }), /reservation is not active/);
  });
});
