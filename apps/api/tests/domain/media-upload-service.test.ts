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
    const asset = await service.upload({ contentId: "123e4567-e89b-42d3-a456-426614174000", kind: "image", mimeType: "image/png", bytes: png });
    assert.equal(uploaded.length, 1);
    assert.equal(saved.length, 1);
    assert.equal(asset.source, "object-storage");
    assert.match(asset.reference, /^affiliate-media\/content\/123e4567-e89b-42d3-a456-426614174000\//);
    assert.equal(asset.byteSize, png.byteLength);
    assert.equal(asset.mimeType, "image/png");
  });

  it("rejects missing content, oversize files, unsupported types, and MIME/signature mismatch before upload", async () => {
    const missing = makeService({ contentExists: false });
    await assert.rejects(missing.service.upload({ contentId: "123e4567-e89b-42d3-a456-426614174001", kind: "image", mimeType: "image/png", bytes: png }), /does not exist/);
    assert.equal(missing.uploaded.length, 0);

    const tooLarge = makeService({ maxImageBytes: 4 });
    await assert.rejects(tooLarge.service.upload({ contentId: "123e4567-e89b-42d3-a456-426614174000", kind: "image", mimeType: "image/png", bytes: png }), /size limit/);
    assert.equal(tooLarge.uploaded.length, 0);

    const mismatch = makeService();
    await assert.rejects(mismatch.service.upload({ contentId: "123e4567-e89b-42d3-a456-426614174000", kind: "image", mimeType: "image/jpeg", bytes: png }), /does not match/);
    assert.equal(mismatch.uploaded.length, 0);

    const unsupported = makeService();
    await assert.rejects(unsupported.service.upload({ contentId: "123e4567-e89b-42d3-a456-426614174000", kind: "video", mimeType: "image/png", bytes: png }), /not allowed/);
    assert.equal(unsupported.uploaded.length, 0);
  });

  it("streams validated PNG chunks to Storage before saving metadata", async () => {
    const saved: MediaAsset[] = [];
    const storageCalls: Array<{ contentType: string; contentLength: number; chunks: number }> = [];
    const removed: string[] = [];
    const storage = {
      async uploadStream(input: { key: string; body: ReadableStream<Uint8Array>; contentType: string; contentLength: number }) {
        const reader = input.body.getReader();
        let chunks = 0;
        let total = 0;
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          chunks += 1;
          total += result.value.byteLength;
        }
        storageCalls.push({ contentType: input.contentType, contentLength: total, chunks });
        assert.equal(total, input.contentLength);
        return { bucket: "affiliate-media", key: input.key };
      },
      async remove(key: string) { removed.push(key); }
    } as unknown as SupabaseStorageClient;
    const repository: MediaAssetRepository = {
      async listByContent() { return saved; },
      async findById(id) { return saved.find((asset) => asset.id === id); },
      async save(asset) { saved.push(asset); return asset; }
    };
    const service = new MediaUploadService(
      { async get(id) { return { id }; } },
      repository,
      storage,
      { maxImageBytes: 1024, maxVideoBytes: 4096 }
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(png.slice(0, 4));
        controller.enqueue(png.slice(4));
        controller.close();
      }
    });
    const asset = await service.uploadStream({
      contentId: "123e4567-e89b-42d3-a456-426614174000",
      kind: "image",
      mimeType: "image/png",
      body,
      contentLength: png.byteLength
    });
    assert.equal(storageCalls.length, 1);
    assert.equal(storageCalls[0].contentType, "image/png");
    assert.equal(storageCalls[0].contentLength, png.byteLength);
    assert.equal(storageCalls[0].chunks, 2);
    assert.equal(saved.length, 1);
    assert.equal(asset.byteSize, png.byteLength);
    assert.equal(removed.length, 0);
  });

  it("preserves a MIME-signature validation error when Storage wraps the stream failure", async () => {
    const removed: string[] = [];
    const storage = {
      async uploadStream(input: { key: string; body: ReadableStream<Uint8Array> }) {
        const reader = input.body.getReader();
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
          }
        } catch {
          // Mimic fetch/Storage wrapping a failed request stream in TypeError.
          throw new TypeError("media upload rejected");
        }
        return { bucket: "affiliate-media", key: input.key };
      },
      async remove(key: string) { removed.push(key); }
    } as unknown as SupabaseStorageClient;
    const repository: MediaAssetRepository = {
      async listByContent() { return []; },
      async findById() { return undefined; },
      async save(asset) { return asset; }
    };
    const service = new MediaUploadService(
      { async get(id) { return { id }; } },
      repository,
      storage,
      { maxImageBytes: 1024, maxVideoBytes: 4096 }
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x6e, 0x6f, 0x74, 0x20, 0x61, 0x20, 0x70, 0x6e, 0x67]));
        controller.close();
      }
    });
    await assert.rejects(service.uploadStream({
      contentId: "123e4567-e89b-42d3-a456-426614174000",
      kind: "image",
      mimeType: "image/png",
      body,
      contentLength: 9
    }), /does not match its declared MIME type/);
    assert.equal(removed.length, 1);
    assert.ok(removed[0].startsWith("content/123e4567-e89b-42d3-a456-426614174000/"));
  });

  it("cleans up a streamed object if streamed metadata persistence fails", async () => {
    const removed: string[] = [];
    const storage = {
      async uploadStream(input: { key: string; body: ReadableStream<Uint8Array> }) {
        const reader = input.body.getReader();
        while (!(await reader.read()).done) { /* consume stream to simulate completed Storage upload */ }
        return { bucket: "affiliate-media", key: input.key };
      },
      async remove(key: string) { removed.push(key); }
    } as unknown as SupabaseStorageClient;
    const repository: MediaAssetRepository = {
      async listByContent() { return []; },
      async findById() { return undefined; },
      async save() { throw new Error("metadata write failed"); }
    };
    const service = new MediaUploadService(
      { async get(id) { return { id }; } },
      repository,
      storage,
      { maxImageBytes: 1024, maxVideoBytes: 4096 }
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(png); controller.close(); }
    });
    await assert.rejects(service.uploadStream({
      contentId: "123e4567-e89b-42d3-a456-426614174000",
      kind: "image",
      mimeType: "image/png",
      body,
      contentLength: png.byteLength
    }), /metadata write failed/);
    assert.equal(removed.length, 1);
    assert.match(removed[0], /^content\/123e4567-e89b-42d3-a456-426614174000\//);
  });

  it("removes the uploaded object if metadata persistence fails", async () => {
    const { service, removed } = makeService({ failSave: true });
    await assert.rejects(service.upload({ contentId: "123e4567-e89b-42d3-a456-426614174000", kind: "image", mimeType: "image/png", bytes: png }), /metadata write failed/);
    assert.equal(removed.length, 1);
    assert.match(removed[0], /^content\/123e4567-e89b-42d3-a456-426614174000\//);
  });
});
