import assert from "node:assert/strict";
import test from "node:test";
import type { ProductMediaAsset } from "../src/domain/product-media-ingestion.js";
import { ProductMediaDeletionCleanupWorker } from "../src/domain/product-media-deletion-cleanup-worker.js";

const asset = (overrides: Partial<ProductMediaAsset> = {}): ProductMediaAsset => ({
  id: "7f1c4c8d-7a2f-4e61-8b0d-1dcb3b48c001",
  productId: "462d1fd3-46d4-4832-a812-0b538ebd8144",
  kind: "image",
  bucket: "affiliate-media",
  storageBackend: "supabase",
  objectKey: "products/462d1fd3-46d4-4832-a812-0b538ebd8144/asset.jpg",
  mimeType: "image/jpeg",
  byteSize: 128,
  sha256: "d".repeat(64),
  sourceUrl: "https://cdn.example.com/product.jpg",
  sourcePublisher: null,
  rightsStatus: "unverified",
  rightsBasis: null,
  rightsEvidenceUrl: null,
  rightsVerifiedAt: null,
  deletionStatus: "pending_cleanup",
  deletedAt: "2026-11-28T00:00:00.000Z",
  deletedBy: "admin-1",
  deletionReason: "Duplicate asset",
  storageCleanupAttempts: 1,
  createdAt: "2026-11-27T00:00:00.000Z",
  ...overrides
});

const repository = (claimed: ProductMediaAsset[], overrides: Record<string, unknown> = {}) => {
  const completed: unknown[] = [];
  const failed: unknown[] = [];
  return {
    completed,
    failed,
    claimDeletionCleanupBatch: async () => claimed,
    completeDeletionCleanup: async (input: unknown) => { completed.push(input); return true; },
    failDeletionCleanup: async (input: unknown) => { failed.push(input); return true; },
    nextDeletionCleanupAt: async () => undefined,
    ...overrides
  };
};

test("removes only the persisted Supabase object key and marks cleanup complete", async () => {
  const row = asset();
  const calls: string[] = [];
  const repo = repository([row]);
  const worker = new ProductMediaDeletionCleanupWorker(repo, {
    supabase: { bucketName: "affiliate-media", upload: async () => ({ bucket: "affiliate-media", key: "unused" }), download: async () => new Uint8Array(), remove: async (key) => { calls.push(key); } }
  });

  await worker.trigger();

  assert.deepEqual(calls, [row.objectKey]);
  assert.equal(repo.completed.length, 1);
  assert.equal(repo.failed.length, 0);
});

test("records a retryable failure without exposing upstream error text", async () => {
  const row = asset({ storageCleanupAttempts: 2 });
  const repo = repository([row]);
  const worker = new ProductMediaDeletionCleanupWorker(repo, {
    supabase: { bucketName: "affiliate-media", upload: async () => ({ bucket: "affiliate-media", key: "unused" }), download: async () => new Uint8Array(), remove: async () => { throw new Error("sensitive upstream response"); } }
  });

  await worker.trigger();

  assert.equal(repo.completed.length, 0);
  assert.equal(repo.failed.length, 1);
  const failure = repo.failed[0] as { errorType: string; nextAttemptAt: string };
  assert.equal(failure.errorType, "Error");
  assert.ok(Number.isFinite(Date.parse(failure.nextAttemptAt)));
  assert.equal(JSON.stringify(failure).includes("sensitive upstream response"), false);
});

test("does not call a storage adapter when its bucket does not match persisted provenance", async () => {
  const row = asset();
  let removed = false;
  const repo = repository([row]);
  const worker = new ProductMediaDeletionCleanupWorker(repo, {
    supabase: { bucketName: "wrong-bucket", upload: async () => ({ bucket: "wrong-bucket", key: "unused" }), download: async () => new Uint8Array(), remove: async () => { removed = true; } }
  });

  await worker.trigger();

  assert.equal(removed, false);
  assert.equal(repo.completed.length, 0);
  assert.equal(repo.failed.length, 1);
  assert.equal((repo.failed[0] as { errorType: string }).errorType, "Error");
});

test("routes local-volume assets only to the local storage adapter", async () => {
  const row = asset({ storageBackend: "local_volume", bucket: "local-volume", objectKey: "e2d3d7f0-9d4a-4f71-9d5a-1f12a5c8b901.jpg" });
  const calls: string[] = [];
  const repo = repository([row]);
  const worker = new ProductMediaDeletionCleanupWorker(repo, {
    localVolume: { bucketName: "local-volume", upload: async () => ({ bucket: "local-volume", key: "unused" }), download: async () => new Uint8Array(), remove: async (key) => { calls.push(key); } }
  });

  await worker.trigger();

  assert.deepEqual(calls, [row.objectKey]);
  assert.equal(repo.completed.length, 1);
  assert.equal(repo.failed.length, 0);
});
