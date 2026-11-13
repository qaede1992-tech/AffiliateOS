import assert from "node:assert/strict";
import test from "node:test";
import type { MediaAsset } from "../../src/domain/media-asset.js";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "../../src/domain/product-media-ingestion.js";
import { assertContentUnchangedSincePublicationOperation, assertProductMediaRightsForPublication } from "../../src/domain/product-media-publication-rights.js";

const productId = "33333333-3333-4333-8333-333333333333";
const media: MediaAsset = {
  id: "22222222-2222-4222-8222-222222222222",
  contentId: "11111111-1111-4111-8111-111111111111",
  kind: "video",
  source: "object-storage",
  reference: `affiliate-media/products/${productId}/video.mp4`,
  mimeType: "video/mp4",
  byteSize: 123,
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z"
};
const verified: ProductMediaAsset = {
  id: "44444444-4444-4444-8444-444444444444",
  productId,
  kind: "video",
  bucket: "affiliate-media",
  objectKey: `products/${productId}/video.mp4`,
  mimeType: "video/mp4",
  byteSize: 123,
  sha256: "a".repeat(64),
  sourceUrl: "https://cdn.example.test/video.mp4",
  sourcePublisher: "Verified publisher",
  rightsStatus: "verified",
  rightsBasis: "explicit_permission",
  rightsEvidenceUrl: "https://publisher.example.test/permission",
  rightsVerifiedAt: "2020-01-01T00:00:00.000Z",
  createdAt: "2026-11-02T00:00:00.000Z"
};

const repository = (...assets: ProductMediaAsset[]): ProductMediaAssetRepository => ({
  async findByProductAndHash() { return undefined; },
  async listByProduct(id) { return assets.filter((asset) => asset.productId === id); },
  async listByProducts(ids) { return assets.filter((asset) => ids.includes(asset.productId)); },
  async save(asset) { return asset; }
});

test("allows product-scoped media only when the exact stored object has verified rights", async () => {
  await assert.doesNotReject(assertProductMediaRightsForPublication([media], [productId], repository(verified)));
});

test("blocks product media when the rights repository is unavailable", async () => {
  await assert.rejects(
    assertProductMediaRightsForPublication([media], [productId]),
    /repository is unavailable/
  );
});

test("blocks unverified, revoked, or incomplete rights evidence at provider dispatch", async () => {
  for (const asset of [
    { ...verified, rightsStatus: "unverified" as const },
    { ...verified, rightsStatus: "revoked" as const },
    { ...verified, rightsEvidenceUrl: "http://publisher.example.test/permission" },
    { ...verified, sourcePublisher: "   " },
    { ...verified, rightsVerifiedAt: "not-a-date" },
    { ...verified, rightsVerifiedAt: new Date(Date.now() + 60_000).toISOString() },
    { ...verified, rightsEvidenceUrl: "https://reviewer:secret@publisher.example.test/permission" }
  ]) {
    await assert.rejects(
      assertProductMediaRightsForPublication([media], [productId], repository(asset)),
      /rights are missing, ambiguous, unverified, or revoked/
    );
  }
});

test("blocks missing, duplicate, and unlinked product media records", async () => {
  await assert.rejects(
    assertProductMediaRightsForPublication([media], [productId], repository()),
    /rights are missing, ambiguous/
  );
  await assert.rejects(
    assertProductMediaRightsForPublication([media], ["55555555-5555-4555-8555-555555555555"], repository(verified)),
    /not linked/
  );
  await assert.rejects(
    assertProductMediaRightsForPublication([media], [productId], repository(verified, verified)),
    /rights are missing, ambiguous/
  );
});

test("blocks an external URL when it is registered as unverified product media", async () => {
  const external = { ...media, source: "url" as const, reference: verified.sourceUrl };
  const unverified = { ...verified, rightsStatus: "unverified" as const };
  await assert.rejects(
    assertProductMediaRightsForPublication([external], [productId], repository(unverified)),
    /rights are missing, ambiguous, unverified, or revoked/
  );
});

test("preserves existing externally hosted media while applying rights checks only to product-scoped objects", async () => {
  const external = { ...media, source: "url" as const, reference: "https://cdn.example.test/legacy-video.mp4" };
  await assert.doesNotReject(assertProductMediaRightsForPublication([external], [productId], repository()));
});

test("preserves legacy content-scoped uploads for the existing publisher resolver", async () => {
  const contentOwned = { ...media, reference: "affiliate-media/content/11111111-1111-4111-8111-111111111111/video.mp4" };
  await assert.doesNotReject(assertProductMediaRightsForPublication([contentOwned], [productId], repository()));
});

test("does not mistake non-product object namespaces for product-media assets", async () => {
  const legacy = { ...media, reference: "affiliate-media/legacy/video.mp4" };
  await assert.doesNotReject(assertProductMediaRightsForPublication([legacy], [productId], repository()));
});


test("blocks final Instagram publication when content changed after its container was created", () => {
  assert.throws(
    () => assertContentUnchangedSincePublicationOperation(
      { updatedAt: "2026-11-14T01:00:01.000Z" },
      { createdAt: "2026-11-14T01:00:00.000Z" }
    ),
    /Content changed after Instagram media container creation/
  );
});

test("allows final Instagram publication when content predates its container", () => {
  assert.doesNotThrow(() => assertContentUnchangedSincePublicationOperation(
    { updatedAt: "2026-11-14T01:00:00.000Z" },
    { createdAt: "2026-11-14T01:00:01.000Z" }
  ));
});

test("fails closed when content or container timestamps are invalid", () => {
  assert.throws(() => assertContentUnchangedSincePublicationOperation(
    { updatedAt: "not-a-date" },
    { createdAt: "2026-11-14T01:00:00.000Z" }
  ));
});
