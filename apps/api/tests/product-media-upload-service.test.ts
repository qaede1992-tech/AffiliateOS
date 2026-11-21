import test from "node:test";
import assert from "node:assert/strict";
import { ProductMediaUploadError, ProductMediaUploadService } from "../src/domain/product-media-upload-service.js";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "../src/domain/product-media-ingestion.js";

const productId = "123e4567-e89b-42d3-a456-426614174000";
const png = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvWQAAAAASUVORK5CYII=",
  "base64"
));

const stream = (bytes: Uint8Array): ReadableStream<Uint8Array> => new ReadableStream({
  start(controller) { controller.enqueue(bytes); controller.close(); }
});

const makeHarness = (overrides: {
  productExists?: boolean;
  prior?: ProductMediaAsset;
  saveError?: Error;
  saveResult?: ProductMediaAsset;
  uploadError?: Error;
  streamingStorage?: boolean;
} = {}) => {
  const calls = { uploads: [] as Array<{ key: string; bytes: Uint8Array; contentType: string }>, streamedUploads: [] as Array<{ key: string; contentLength: number; contentType: string }>, removals: [] as string[], saved: [] as ProductMediaAsset[] };
  const assets: ProductMediaAssetRepository = {
    async findByProductAndHash() { return overrides.prior; },
    async findBySourceCandidateId() { return undefined; },
    async listByProduct() { return []; },
    async save(asset) {
      if (overrides.saveError) throw overrides.saveError;
      calls.saved.push(asset);
      return overrides.saveResult ?? asset;
    }
  };
  const service = new ProductMediaUploadService(
    { async findById() { return overrides.productExists === false ? undefined : { id: productId }; } },
    assets,
    {
      async upload(input) {
        calls.uploads.push(input);
        if (overrides.uploadError) throw overrides.uploadError;
        return { bucket: "affiliate-media", key: input.key };
      },
      ...(overrides.streamingStorage ? {
        async uploadStream(input: { key: string; body: ReadableStream<Uint8Array>; contentType: string; contentLength: number }) {
          calls.streamedUploads.push({ key: input.key, contentLength: input.contentLength, contentType: input.contentType });
          const reader = input.body.getReader();
          let total = 0;
          try { while (true) { const part = await reader.read(); if (part.done) break; total += part.value?.byteLength ?? 0; } }
          finally { reader.releaseLock(); }
          assert.equal(total, input.contentLength);
          return { bucket: "affiliate-media", key: input.key };
        }
      } : {}),
      async remove(key) { calls.removals.push(key); }
    },
    { maxImageBytes: 1024 * 1024, maxVideoBytes: 2 * 1024 * 1024 }
  );
  return { service, calls };
};

const input = (bytes = png) => ({
  productId,
  kind: "image" as const,
  mimeType: "image/png",
  body: stream(bytes),
  contentLength: bytes.byteLength
});

test("uploads product media without creating content and leaves rights unverified", async () => {
  const { service, calls } = makeHarness();
  const asset = await service.uploadStream(input());
  assert.equal(calls.uploads.length, 1);
  assert.match(asset.objectKey, new RegExp(`^products/${productId}/`));
  assert.equal(asset.rightsStatus, "unverified");
  assert.equal(asset.rightsBasis, null);
  assert.equal(asset.rightsEvidenceUrl, null);
  assert.equal(asset.rightsVerifiedAt, null);
  assert.equal(asset.sourceProvider, "user_upload");
  assert.equal(asset.sourcePublisher, "user-provided");
  assert.equal(asset.sourceUrl, `user-upload://${asset.id}`);
  assert.equal(asset.byteSize, png.byteLength);
});

test("persists declared source provenance while keeping rights unverified", async () => {
  const { service, calls } = makeHarness();
  const asset = await service.uploadStream({
    ...input(),
    sourcePublisher: "Shopee Affiliate Program",
    sourceLandingPageUrl: "https://shopee.co.id/product/123",
    sourceLicense: "Shopee Affiliate Terms",
    sourceLicenseUrl: "https://example.com/affiliate-terms"
  });
  assert.equal(calls.saved.length, 1);
  assert.equal(asset.sourcePublisher, "Shopee Affiliate Program");
  assert.equal(asset.sourceLandingPageUrl, "https://shopee.co.id/product/123");
  assert.equal(asset.sourceLicense, "Shopee Affiliate Terms");
  assert.equal(asset.sourceLicenseUrl, "https://example.com/affiliate-terms");
  assert.equal(asset.rightsStatus, "unverified");
  assert.equal(asset.rightsBasis, null);
  assert.equal(asset.rightsEvidenceUrl, null);
});

test("rejects invalid provenance URLs and blank source publishers before storage", async () => {
  const { service, calls } = makeHarness();
  await assert.rejects(service.uploadStream({ ...input(), sourceLandingPageUrl: "http://shopee.co.id/item" }), (error: unknown) =>
    error instanceof ProductMediaUploadError && error.code === "INVALID_SOURCE_METADATA");
  await assert.rejects(service.uploadStream({ ...input(), sourcePublisher: "   " }), (error: unknown) =>
    error instanceof ProductMediaUploadError && error.code === "INVALID_SOURCE_METADATA");
  assert.equal(calls.uploads.length, 0);
});

test("rejects unknown products before writing storage", async () => {
  const { service, calls } = makeHarness({ productExists: false });
  await assert.rejects(service.uploadStream(input()), (error: unknown) =>
    error instanceof ProductMediaUploadError && error.code === "PRODUCT_NOT_FOUND");
  assert.equal(calls.uploads.length, 0);
});

test("rejects a MIME and file-signature mismatch", async () => {
  const { service, calls } = makeHarness();
  await assert.rejects(service.uploadStream({ ...input(), mimeType: "image/jpeg" }), (error: unknown) =>
    error instanceof ProductMediaUploadError && error.code === "INVALID_MEDIA_BYTES");
  assert.equal(calls.uploads.length, 0);
});

test("deduplicates identical media for the same product", async () => {
  const prior = {
    id: "asset-id", productId, kind: "image" as const, bucket: "affiliate-media", objectKey: "products/existing.png",
    mimeType: "image/png" as const, byteSize: png.byteLength, sha256: "hash", sourceUrl: "user-upload://prior",
    sourcePublisher: "user-provided", rightsStatus: "unverified" as const, rightsBasis: null,
    rightsEvidenceUrl: null, rightsVerifiedAt: null, createdAt: new Date().toISOString()
  };
  const { service, calls } = makeHarness({ prior });
  const result = await service.uploadStream(input());
  assert.equal(result.id, prior.id);
  assert.equal(calls.uploads.length, 0);
});

test("does not silently accept duplicate media with conflicting source provenance", async () => {
  const prior: ProductMediaAsset = {
    id: "asset-id", productId, kind: "image", bucket: "affiliate-media", objectKey: "products/existing.png",
    mimeType: "image/png", byteSize: png.byteLength, sha256: "hash", sourceUrl: "user-upload://prior",
    sourcePublisher: "Earlier publisher", sourceLandingPageUrl: "https://example.com/old",
    sourceLicense: "Earlier license", sourceLicenseUrl: "https://example.com/old-license",
    rightsStatus: "unverified", rightsBasis: null, rightsEvidenceUrl: null, rightsVerifiedAt: null,
    createdAt: new Date().toISOString()
  };
  const { service, calls } = makeHarness({ prior });
  await assert.rejects(
    service.uploadStream({
      ...input(), sourcePublisher: "New publisher", sourceLandingPageUrl: "https://example.com/new",
      sourceLicense: "New license", sourceLicenseUrl: "https://example.com/new-license"
    }),
    (error: unknown) => error instanceof ProductMediaUploadError && error.code === "INVALID_SOURCE_METADATA"
  );
  assert.equal(calls.uploads.length, 0);
});

test("removes stored object when asset metadata persistence fails", async () => {
  const { service, calls } = makeHarness({ saveError: new Error("database unavailable") });
  await assert.rejects(service.uploadStream(input()), /database unavailable/);
  assert.equal(calls.uploads.length, 1);
  assert.deepEqual(calls.removals, [calls.uploads[0]!.key]);
});

test("rejects a mismatched Content-Length", async () => {
  const { service, calls } = makeHarness();
  await assert.rejects(service.uploadStream({ ...input(), contentLength: png.byteLength + 1 }), (error: unknown) =>
    error instanceof ProductMediaUploadError && error.code === "CONTENT_LENGTH_MISMATCH");
  assert.equal(calls.uploads.length, 0);
});


test("cancels an oversized upload stream before any storage write", async () => {
  const { service, calls } = makeHarness();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(
    service.uploadStream({ ...input(), body, contentLength: 1024 * 1024 }),
    (error: unknown) => error instanceof ProductMediaUploadError && error.code === "MEDIA_TOO_LARGE"
  );
  assert.equal(cancelled, true);
  assert.equal(calls.uploads.length, 0);
});

test("removes a losing storage object when a concurrent insert returns the winning asset", async () => {
  const winner: ProductMediaAsset = {
    id: "winner-asset",
    productId,
    kind: "image",
    bucket: "affiliate-media",
    objectKey: `products/${productId}/winner.png`,
    mimeType: "image/png",
    byteSize: png.byteLength,
    width: 1,
    height: 1,
    durationMs: null,
    hasAudio: null,
    sha256: "winner-hash",
    sourceUrl: "user-upload://winner",
    sourcePublisher: "user-provided",
    sourceProvider: "user_upload",
    rightsStatus: "unverified",
    rightsBasis: null,
    rightsEvidenceUrl: null,
    rightsVerifiedAt: null,
    createdAt: new Date().toISOString()
  };
  const { service, calls } = makeHarness({ saveResult: winner });
  const result = await service.uploadStream(input());
  assert.equal(result.id, winner.id);
  assert.deepEqual(calls.removals, [calls.uploads[0]!.key]);
});


test("uses the streaming Storage adapter after validating bounded media bytes", async () => {
  const { service, calls } = makeHarness({ streamingStorage: true });
  const asset = await service.uploadStream(input());
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.streamedUploads.length, 1);
  assert.equal(calls.streamedUploads[0]?.contentLength, png.byteLength);
  assert.equal(calls.streamedUploads[0]?.contentType, "image/png");
  assert.equal(asset.rightsStatus, "unverified");
});
