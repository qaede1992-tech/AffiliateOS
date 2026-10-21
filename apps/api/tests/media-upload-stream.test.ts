import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaUploadService } from "../src/domain/media-upload-service.js";

const contentId = "123e4567-e89b-42d3-a456-426614174000";
const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function createService(options: { failMetadata?: boolean; failStorage?: boolean; maxImageBytes?: number } = {}) {
  const saved: unknown[] = [];
  const removed: string[] = [];
  let storedBytes = 0;
  const storage = {
    async uploadStream(input: { key: string; body: ReadableStream<Uint8Array> }) {
      if (options.failStorage) throw new Error("storage unavailable");
      const reader = input.body.getReader();
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          storedBytes += item.value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      return { bucket: "private-media", key: input.key };
    },
    async remove(key: string) { removed.push(key); }
  };
  const repository = {
    async listByContent() { return []; },
    async findById() { return undefined; },
    async save(asset: unknown) {
      if (options.failMetadata) throw new Error("metadata unavailable");
      saved.push(asset);
      return asset;
    }
  };
  const service = new MediaUploadService(
    { async get(id: string) { return id === contentId ? { id } : undefined; } },
    repository as never,
    storage as never,
    { maxImageBytes: options.maxImageBytes ?? 1024, maxVideoBytes: 4096 }
  );
  return { service, saved, removed, get storedBytes() { return storedBytes; } };
}

function streamOf(bytes: Uint8Array, chunkSize = bytes.byteLength) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.byteLength; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    }
  });
}

test("stream upload validates signature across chunk boundaries and saves metadata after storage", async () => {
  const fixture = createService();
  const asset = await fixture.service.uploadStream({
    contentId, kind: "image", mimeType: "image/png", contentLength: pngHeader.byteLength,
    body: streamOf(pngHeader, 3)
  });
  assert.equal(fixture.storedBytes, pngHeader.byteLength);
  assert.equal(fixture.saved.length, 1);
  assert.equal(asset.byteSize, pngHeader.byteLength);
  assert.equal(asset.reference.startsWith("private-media/content/"), true);
});

test("stream upload rejects a false signature and removes the partial object", async () => {
  const fixture = createService();
  const falseHeader = new Uint8Array(12).fill(0x41);
  await assert.rejects(fixture.service.uploadStream({
    contentId, kind: "image", mimeType: "image/png", contentLength: falseHeader.byteLength,
    body: streamOf(falseHeader, 4)
  }), /signature|MIME type/i);
  assert.equal(fixture.saved.length, 0);
  assert.equal(fixture.removed.length, 1);
});

test("stream upload rejects an over-limit declared length before reading body", async () => {
  const fixture = createService({ maxImageBytes: 8 });
  let read = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { read = true; controller.enqueue(pngHeader); controller.close(); } });
  await assert.rejects(fixture.service.uploadStream({
    contentId, kind: "image", mimeType: "image/png", contentLength: 12, body
  }), /size limit/i);
  assert.equal(read, false);
});

test("stream upload removes object if metadata persistence fails", async () => {
  const fixture = createService({ failMetadata: true });
  await assert.rejects(fixture.service.uploadStream({
    contentId, kind: "image", mimeType: "image/png", contentLength: pngHeader.byteLength,
    body: streamOf(pngHeader, 5)
  }), /metadata unavailable/);
  assert.equal(fixture.saved.length, 0);
  assert.equal(fixture.removed.length, 1);
});


test("stream upload rejects an oversized chunk even when Content-Length is within limit", async () => {
  const fixture = createService({ maxImageBytes: 16 });
  const oversized = new Uint8Array(20).fill(0x41);
  await assert.rejects(fixture.service.uploadStream({
    contentId, kind: "image", mimeType: "image/png", contentLength: 16,
    body: streamOf(oversized, 20)
  }), /size limit/i);
  assert.equal(fixture.saved.length, 0);
  assert.equal(fixture.removed.length, 1);
});

test("stream upload attempts cleanup when the Storage provider rejects the request", async () => {
  const fixture = createService({ failStorage: true });
  await assert.rejects(fixture.service.uploadStream({
    contentId, kind: "image", mimeType: "image/png", contentLength: pngHeader.byteLength,
    body: streamOf(pngHeader)
  }), /storage unavailable/);
  assert.equal(fixture.saved.length, 0);
  assert.equal(fixture.removed.length, 1);
});
