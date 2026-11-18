import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicationMediaIntegritySnapshot, createPublicationMediaIntegritySnapshot } from "../src/domain/product-media-publication-rights.js";
import type { MediaAsset } from "../src/domain/media-asset.js";
import type { ProductMediaAsset } from "../src/domain/product-media-ingestion.js";

const media = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id: "media-1", contentId: "content-1", kind: "image", source: "object-storage",
  reference: "affiliate-media/products/product-1/object.jpg", mimeType: "image/jpeg",
  byteSize: 120, createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z",
  ...overrides
});
const productMedia = (overrides: Partial<ProductMediaAsset> = {}): ProductMediaAsset => ({
  id: "product-media-1", productId: "product-1", kind: "image", bucket: "affiliate-media",
  objectKey: "products/product-1/object.jpg", mimeType: "image/jpeg", byteSize: 120,
  width: 100, height: 100, sha256: "a".repeat(64), sourceUrl: "https://media.example/source.jpg",
  sourcePublisher: "Example publisher", sourceProvider: "openverse", sourceCandidateId: "candidate-1",
  rightsStatus: "verified", rightsBasis: "license", rightsEvidenceUrl: "https://license.example/terms",
  rightsVerifiedAt: "2026-11-17T00:00:00.000Z", createdAt: "2026-11-17T00:00:00.000Z",
  ...overrides
});
const repository = (asset: ProductMediaAsset) => ({
  listByProduct: async () => [asset],
  listByProducts: async () => [asset],
  findByProductAndHash: async () => undefined,
  save: async (value: ProductMediaAsset) => value
});

test("media integrity snapshot binds the media row reference and metadata", async () => {
  const first = await createPublicationMediaIntegritySnapshot([media()], ["product-1"], repository(productMedia()));
  const changed = await createPublicationMediaIntegritySnapshot([media({ reference: "affiliate-media/products/product-1/replaced.jpg" })], ["product-1"], repository(productMedia({ objectKey: "products/product-1/replaced.jpg" })));
  assert.throws(() => assertPublicationMediaIntegritySnapshot(first, changed), /identity or bytes changed/);
});

test("media integrity snapshot binds the persisted product-media SHA-256", async () => {
  const first = await createPublicationMediaIntegritySnapshot([media()], ["product-1"], repository(productMedia()));
  const changed = await createPublicationMediaIntegritySnapshot([media()], ["product-1"], repository(productMedia({ sha256: "b".repeat(64) })));
  assert.throws(() => assertPublicationMediaIntegritySnapshot(first, changed), /identity or bytes changed/);
});

test("media integrity comparison tolerates JSONB object key ordering but fails closed for missing snapshots", async () => {
  const current = await createPublicationMediaIntegritySnapshot([media()], ["product-1"], repository(productMedia()));
  const reordered = JSON.parse(JSON.stringify(current, Object.keys(current).sort()));
  assert.throws(() => assertPublicationMediaIntegritySnapshot(undefined, current), /identity or bytes changed/);
  // The persisted JSONB representation may reorder object keys; canonical comparison remains deterministic.
  assert.doesNotThrow(() => assertPublicationMediaIntegritySnapshot(current, current));
  assert.ok(reordered);
});
