import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IllustrativeCreativeFileStore } from "../../src/domain/illustrative-creative-file-store.js";

const sample = new Uint8Array(Buffer.from("illustrative-mp4-test-payload"));

test("stores and retrieves a file by opaque relative key with SHA-256 verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "affiliateos-creative-store-"));
  try {
    const store = new IllustrativeCreativeFileStore({ rootDirectory: root });
    const creativeId = randomUUID();
    const sha256 = createHash("sha256").update(sample).digest("hex");
    const stored = await store.put({ creativeId, bytes: sample, expectedSha256: sha256 });
    assert.equal(stored.key, `${creativeId}-${sha256}.mp4`);
    assert.equal(stored.byteSize, sample.byteLength);
    assert.deepEqual(await store.get({ key: stored.key, expectedSha256: sha256, expectedByteSize: sample.byteLength }), sample);
    await store.remove(stored.key);
    await assert.rejects(() => store.get({ key: stored.key, expectedSha256: sha256, expectedByteSize: sample.byteLength }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects mismatched digest, invalid identifiers, oversized data, and path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "affiliateos-creative-store-"));
  try {
    const store = new IllustrativeCreativeFileStore({ rootDirectory: root, maxBytes: 8 });
    const creativeId = randomUUID();
    const sha256 = createHash("sha256").update(sample).digest("hex");
    await assert.rejects(() => store.put({ creativeId, bytes: sample, expectedSha256: "a".repeat(64) }), /SHA-256/);
    await assert.rejects(() => store.put({ creativeId: "../escape", bytes: sample, expectedSha256: sha256 }), /UUID/);
    await assert.rejects(() => store.put({ creativeId, bytes: sample, expectedSha256: sha256 }), /size limit/);
    await assert.rejects(() => store.get({ key: "../escape", expectedSha256: sha256, expectedByteSize: sample.byteLength }), /key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not overwrite an existing creative file", async () => {
  const root = await mkdtemp(join(tmpdir(), "affiliateos-creative-store-"));
  try {
    const store = new IllustrativeCreativeFileStore({ rootDirectory: root });
    const creativeId = randomUUID();
    const sha256 = createHash("sha256").update(sample).digest("hex");
    const stored = await store.put({ creativeId, bytes: sample, expectedSha256: sha256 });
    await assert.rejects(() => store.put({ creativeId, bytes: sample, expectedSha256: sha256 }));
    assert.deepEqual(new Uint8Array(await readFile(join(root, stored.key))), sample);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
