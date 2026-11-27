import test from "node:test";
import assert from "node:assert/strict";
import { IllustrativeProductVideoAssetService } from "../../src/domain/illustrative-product-video-asset.js";

const PRODUCT_ID = "a7f34e18-2a77-4c9e-a1f7-0f8a0f8d6a10";
const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);

const rendered = {
  bytes,
  metadata: {
    mimeType: "video/mp4" as const,
    width: 720 as const,
    height: 1280 as const,
    durationMs: 12_000 as const,
    fps: 25 as const,
    codec: "h264" as const,
    sha256: "a".repeat(64),
    byteSize: bytes.byteLength
  }
};

test("persists an illustrative video as unverified product media without granting publication rights", async () => {
  let saved: any;
  let uploaded: any;
  const preview = { async render(productId: string) { assert.equal(productId, PRODUCT_ID); return rendered; } };
  const storage = {
    bucketName: "affiliate-media",
    async upload(input: any) { uploaded = input; return { backend: "local_volume", bucket: "local-volume", key: input.key }; },
    async remove() {}
  };
  const assets = {
    async findByProductAndSourceUrl() { return undefined; },
    async findByProductAndHash() { return undefined; },
    async save(asset: any) { saved = asset; return asset; }
  };
  const service = new IllustrativeProductVideoAssetService(preview as never, storage as never, assets as never);
  const result = await service.generate(PRODUCT_ID);

  assert.equal(result.generated, true);
  assert.equal(result.asset.productId, PRODUCT_ID);
  assert.equal(result.asset.kind, "video");
  assert.equal(result.asset.bucket, "local-volume");
  assert.equal(result.asset.storageBackend, "local_volume");
  assert.equal(result.asset.mimeType, "video/mp4");
  assert.equal(result.asset.rightsStatus, "unverified");
  assert.equal(result.asset.rightsBasis, null);
  assert.equal(result.asset.rightsVerifiedAt, null);
  assert.equal(result.asset.identityStatus, "not_required");
  assert.equal(result.asset.identityReviewedBy, null);
  assert.equal(result.asset.identityReviewedAt, null);
  assert.equal(result.asset.identityReviewReason, null);
  assert.equal(result.asset.sourceProvider, "affiliateos-illustrative-renderer");
  assert.match(result.asset.sourceTitle ?? "", /not a product photograph/i);
  assert.equal(uploaded.contentType, "video/mp4");
  assert.equal(saved.objectKey, uploaded.key);
  assert.equal(saved.storageBackend, "local_volume");
});

test("reuses an existing illustrative video without rendering or uploading again", async () => {
  const existing = { id: "asset-1", productId: PRODUCT_ID, kind: "video", rightsStatus: "revoked" };
  let renderCalls = 0;
  let uploadCalls = 0;
  const preview = { async render() { renderCalls++; return rendered; } };
  const storage = {
    bucketName: "affiliate-media",
    async upload() { uploadCalls++; return { bucket: "affiliate-media", key: "unused" }; },
    async remove() {}
  };
  const assets = {
    async findByProductAndSourceUrl() { return existing; },
    async findByProductAndHash() { throw new Error("hash lookup should not be reached"); },
    async save() { throw new Error("save should not be reached"); }
  };
  const service = new IllustrativeProductVideoAssetService(preview as never, storage as never, assets as never);
  const result = await service.generate(PRODUCT_ID);

  assert.equal(result.generated, false);
  assert.equal(result.asset, existing);
  assert.equal(result.asset.rightsStatus, "revoked", "idempotent reuse must not restore revoked rights");
  assert.equal(renderCalls, 0);
  assert.equal(uploadCalls, 0);
});

test("removes the uploaded object if the database asset write fails", async () => {
  const removed: string[] = [];
  const storage = {
    bucketName: "affiliate-media",
    async upload(input: any) { return { backend: "local_volume", bucket: "local-volume", key: input.key }; },
    async remove(key: string) { removed.push(key); }
  };
  const assets = {
    async findByProductAndSourceUrl() { return undefined; },
    async findByProductAndHash() { return undefined; },
    async save() { throw new Error("database write failed"); }
  };
  const service = new IllustrativeProductVideoAssetService(
    { async render() { return rendered; } } as never,
    storage as never,
    assets as never
  );
  await assert.rejects(() => service.generate(PRODUCT_ID), /database write failed/);
  assert.equal(removed.length, 1);
  assert.match(removed[0], new RegExp(`products/${PRODUCT_ID}/illustrative-`));
});
