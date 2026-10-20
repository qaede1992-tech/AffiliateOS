import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MediaAsset, MediaAssetRepository } from "../../src/domain/media-asset.js";
import { MediaUploadService } from "../../src/domain/media-upload-service.js";
import type { SupabaseStorageClient, StoredObject } from "../../src/domain/supabase-storage.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const makeService = (options: { contentExists?: boolean; failSave?: boolean; maxImageBytes?: number } = {}) => {
  const saved: MediaAsset[] = [];
  const uploaded: Array<{ key: string; bytes: Uint8Array; contentType: string }> = [];
  const removed: string[] = [];
  const storage = {
    async upload(input: { key: string; bytes: Uint8Array; contentType: string }): Promise<StoredObject> {
      uploaded.push(input);
      return { bucket: "affiliate-media", key: input.key };
    },
    async remove(key: string) { removed.push(key); }
  } as unknown as SupabaseStorageClient;
  const repository: MediaAssetRepository = {
    async listByContent() { return saved; },
    async findById(id) { return saved.find((asset) => asset.id === id); },
    async save(asset) {
      if (options.failSave) throw new Error("metadata write failed");
      saved.push(asset);
      return asset;
    }
  };
  const service = new MediaUploadService(
    { async get(id) { return options.contentExists === false ? undefined : { id }; } },
    repository,
    storage,
    { maxImageBytes: options.maxImageBytes ?? 1024, maxVideoBytes: 4096 }
  );
  return { service, saved, uploaded, removed };
};

describe("MediaUploadService", () => {
  it("uploads validated image bytes and stores only a bucket/key reference in metadata", async () => {
    const { service, saved, uploaded } = makeService();
    const asset = await service.upload({ contentId: "content-1", kind: "image", mimeType: "image/png", bytes: png });
    assert.equal(uploaded.length, 1);
    assert.equal(saved.length, 1);
    assert.equal(asset.source, "object-storage");
    assert.match(asset.reference, /^affiliate-media\/content\/content-1\//);
    assert.equal(asset.byteSize, png.byteLength);
    assert.equal(asset.mimeType, "image/png");
  });

  it("rejects missing content, oversize files, unsupported types, and MIME/signature mismatch before upload", async () => {
    const missing = makeService({ contentExists: false });
    await assert.rejects(missing.service.upload({ contentId: "missing", kind: "image", mimeType: "image/png", bytes: png }), /does not exist/);
    assert.equal(missing.uploaded.length, 0);

    const tooLarge = makeService({ maxImageBytes: 4 });
    await assert.rejects(tooLarge.service.upload({ contentId: "content-1", kind: "image", mimeType: "image/png", bytes: png }), /size limit/);
    assert.equal(tooLarge.uploaded.length, 0);

    const mismatch = makeService();
    await assert.rejects(mismatch.service.upload({ contentId: "content-1", kind: "image", mimeType: "image/jpeg", bytes: png }), /does not match/);
    assert.equal(mismatch.uploaded.length, 0);

    const unsupported = makeService();
    await assert.rejects(unsupported.service.upload({ contentId: "content-1", kind: "video", mimeType: "image/png", bytes: png }), /not allowed/);
    assert.equal(unsupported.uploaded.length, 0);
  });

  it("removes the uploaded object if metadata persistence fails", async () => {
    const { service, removed } = makeService({ failSave: true });
    await assert.rejects(service.upload({ contentId: "content-1", kind: "image", mimeType: "image/png", bytes: png }), /metadata write failed/);
    assert.equal(removed.length, 1);
    assert.match(removed[0], /^content\/content-1\//);
  });
});
