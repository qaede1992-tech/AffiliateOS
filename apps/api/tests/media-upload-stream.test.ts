import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaUploadService } from "../src/domain/media-upload-service.js";

const contentId = "123e4567-e89b-42d3-a456-426614174000";
const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function createService(options: { failMetadata?: boolean; failStorage?: boolean; failStorageAfterPartial?: boolean; maxImageBytes?: number } = {}) {
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
          if (options.failStorageAfterPartial) throw new Error("storage stream failed after accepting partial bytes");
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
  const body = new ReadableStream<Uint8Array>({ pull(controller) { read = true; controller.enqueue(pngHeader); controller.close(); } }, { highWaterMark: 0 });
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



test("stream upload removes a partially accepted Storage object when the provider fails mid-stream", async () => {
  const fixture = createService({ failStorageAfterPartial: true });
  const payload = new Uint8Array([...pngHeader, ...new Uint8Array(32).fill(0x5a)]);
  await assert.rejects(fixture.service.uploadStream({
    contentId, kind: "image", mimeType: "image/png", contentLength: payload.byteLength,
    body: streamOf(payload, 12)
  }), /storage stream failed after accepting partial bytes/);
  assert.ok(fixture.storedBytes > 0, "the fake Storage provider must accept some bytes before failing");
  assert.equal(fixture.saved.length, 0, "metadata must not be saved after a partial Storage failure");
  assert.equal(fixture.removed.length, 1, "the deterministic object key must be removed after partial acceptance");
  assert.match(fixture.removed[0]!, new RegExp("^content/" + contentId + "/"));
});

test("stream upload rejects a body shorter than its declared Content-Length", async () => {
  const fixture = createService();
  const shortBody = streamOf(pngHeader.slice(0, 8), 4);
  await assert.rejects(fixture.service.uploadStream({
    contentId, kind: "image", mimeType: "image/png", contentLength: 12,
    body: shortBody
  }), /length does not match|MIME type/i);
  assert.equal(fixture.saved.length, 0);
  assert.equal(fixture.removed.length, 1);
});

test("stream upload cancels its reader when the request signal is aborted", async () => {
  const fixture = createService();
  const controller = new AbortController();
  let cancelled = false;
  let emitted = false;
  const body = new ReadableStream<Uint8Array>({
    pull(streamController) {
      if (!emitted) {
        emitted = true;
        streamController.enqueue(pngHeader);
      }
      // Leave the stream open after its first chunk so abort can cancel it.
    },
    cancel() { cancelled = true; }
  });
  const pending = fixture.service.uploadStream({
    contentId, kind: "image", mimeType: "image/png", contentLength: 24,
    body, signal: controller.signal
  });
  controller.abort();
  await assert.rejects(pending);
  assert.equal(cancelled, true);
  assert.equal(fixture.saved.length, 0);
  assert.equal(fixture.removed.length, 1);
});
