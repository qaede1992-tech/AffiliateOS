import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProductMediaStorage } from "../src/domain/local-product-media-storage.js";

const imageBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

test("local product media storage persists opaque objects and reads the exact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "affiliateos-product-media-"));
  try {
    const storage = new LocalProductMediaStorage({ rootDirectory: root, maxImageBytes: 1024, maxVideoBytes: 2048 });
    const saved = await storage.upload({ bytes: imageBytes, contentType: "image/jpeg" });
    assert.equal(saved.backend, "local_volume");
    assert.equal(saved.bucket, "local-volume");
    assert.equal(storage.bucketName, "local-volume");
    assert.equal(saved.byteSize, imageBytes.byteLength);
    assert.match(saved.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await storage.read(saved.key, 1024), imageBytes);
    assert.deepEqual(await storage.download(saved.key, 1024), imageBytes);
    assert.equal((await storage.inspect(saved.key)).byteSize, imageBytes.byteLength);
    await storage.remove(saved.key);
    await assert.rejects(() => storage.read(saved.key, 1024));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local product media storage rejects traversal and non-opaque keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "affiliateos-product-media-"));
  try {
    const storage = new LocalProductMediaStorage({ rootDirectory: root, maxImageBytes: 1024, maxVideoBytes: 2048 });
    await assert.rejects(() => storage.read("../secret.jpg", 1024), /opaque/);
    await assert.rejects(() => storage.remove("products/secret.jpg"), /opaque/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local product media storage refuses symlink objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "affiliateos-product-media-"));
  const outside = await mkdtemp(join(tmpdir(), "affiliateos-product-media-outside-"));
  const key = "123e4567-e89b-42d3-a456-426614174000.jpg";
  try {
    const storage = new LocalProductMediaStorage({ rootDirectory: root, maxImageBytes: 1024, maxVideoBytes: 2048 });
    await symlink(join(outside, "missing.jpg"), join(root, key));
    await assert.rejects(() => storage.read(key, 1024), /unsafe|regular file/);
    await assert.rejects(() => storage.remove(key), /non-regular/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("local product media storage enforces kind, MIME, and byte limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "affiliateos-product-media-"));
  try {
    const storage = new LocalProductMediaStorage({ rootDirectory: root, maxImageBytes: 3, maxVideoBytes: 8 });
    await assert.rejects(() => storage.upload({ bytes: imageBytes, contentType: "image/jpeg", kind: "image" }), /exceed/);
    await assert.rejects(() => storage.upload({ bytes: imageBytes, contentType: "video/mp4" }), /MIME/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
