import assert from "node:assert/strict";
import test from "node:test";
import { ProductMediaIngestionService } from "../src/domain/product-media-ingestion.js";

const productId = "462d1fd3-46d4-4832-a812-0b538ebd8144";

test("does not ingest media before non-media affiliate eligibility passes", async () => {
  let listed = 0;
  let fetched = 0;
  const storage = { upload: async () => { throw new Error("must not upload"); } } as never;
  const repository = {
    listByProduct: async () => { listed++; return []; },
    findByProductAndHash: async () => undefined,
    save: async () => { throw new Error("must not save"); }
  } as never;
  const fetcher = (async () => { fetched++; throw new Error("must not fetch"); }) as never;
  const service = new ProductMediaIngestionService(storage, repository, { maxImageBytes: 1024, maxVideoBytes: 1024 }, fetcher);
  await assert.rejects(() => service.ingest({
    productId,
    nonMediaEligibilityPassed: false,
    candidates: [{ kind: "image", url: "https://cdn.example.com/image.png", source: "og" }]
  }), /must pass non-media affiliate eligibility/);
  assert.equal(listed, 0);
  assert.equal(fetched, 0);
});

test("returns an empty result without creating content when no media candidates exist", async () => {
  const repository = { listByProduct: async () => [], findByProductAndHash: async () => undefined, save: async (asset: unknown) => asset } as never;
  const storage = { upload: async () => { throw new Error("no upload expected"); } } as never;
  const service = new ProductMediaIngestionService(storage, repository, { maxImageBytes: 1024, maxVideoBytes: 1024 });
  const result = await service.ingest({ productId, nonMediaEligibilityPassed: true, candidates: [] });
  assert.deepEqual(result, { stored: [], skipped: [] });
});

test("ingests a valid product video without requiring a product image", async () => {
  // Minimal structurally valid ISO-BMFF: an ftyp box followed by a non-empty mdat box.
  const bytes = Uint8Array.from([
    0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
    0, 0, 0, 9, 0x6d, 0x64, 0x61, 0x74, 1
  ]);
  const uploads: Array<{ key: string; contentType: string }> = [];
  const saved: Array<Record<string, unknown>> = [];
  const storage = {
    upload: async (input: { key: string; contentType: string }) => {
      uploads.push({ key: input.key, contentType: input.contentType });
      return { bucket: "affiliate-media", key: input.key };
    },
    remove: async () => {}
  } as never;
  const repository = {
    listByProduct: async () => [],
    findByProductAndHash: async () => undefined,
    save: async (asset: Record<string, unknown>) => { saved.push(asset); return asset; }
  } as never;
  const fetcher = (async () => ({ status: 200, headers: {}, url: "https://cdn.example.com/product.mp4", bytes })) as never;
  const service = new ProductMediaIngestionService(
    storage,
    repository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 },
    fetcher
  );

  const result = await service.ingest({
    productId,
    nonMediaEligibilityPassed: true,
    candidates: [{ kind: "video", url: "https://cdn.example.com/product.mp4", source: "og" }]
  });

  assert.equal(result.stored.length, 1);
  assert.equal(result.stored[0]?.kind, "video");
  assert.equal(result.stored[0]?.mimeType, "video/mp4");
  assert.equal(result.skipped.length, 0);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.contentType, "video/mp4");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.rightsStatus, "unverified");
  assert.equal(saved[0]?.rightsBasis, null);
  assert.equal(saved[0]?.rightsEvidenceUrl, null);
});


test("concurrent duplicate ingestion cannot remove the object stored by the winning insert", async () => {
  const bytes = Uint8Array.from([
    0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
    0, 0, 0, 9, 0x6d, 0x64, 0x61, 0x74, 1
  ]);
  const uploads: string[] = [];
  const removed: string[] = [];
  const saved: Array<Record<string, unknown>> = [];
  let findCount = 0;
  let releaseFinds!: () => void;
  const bothFinds = new Promise<void>((resolve) => { releaseFinds = resolve; });
  const storage = {
    upload: async (input: { key: string }) => {
      uploads.push(input.key);
      return { bucket: "affiliate-media", key: input.key };
    },
    remove: async (key: string) => { removed.push(key); }
  } as never;
  const repository = {
    listByProduct: async () => [],
    findByProductAndHash: async () => {
      findCount += 1;
      if (findCount === 2) releaseFinds();
      await bothFinds;
      return undefined;
    },
    save: async (asset: Record<string, unknown>) => {
      const existing = saved.find((item) => item.sha256 === asset.sha256);
      if (existing) return existing;
      saved.push(asset);
      return asset;
    }
  } as never;
  const fetcher = (async () => ({ status: 200, headers: {}, url: "https://cdn.example.com/product.mp4", bytes })) as never;
  const makeService = () => new ProductMediaIngestionService(
    storage, repository, { maxImageBytes: 1024, maxVideoBytes: 1024 }, fetcher
  );
  const input = {
    productId, nonMediaEligibilityPassed: true,
    candidates: [{ kind: "video" as const, url: "https://cdn.example.com/product.mp4", source: "catalog" as const }]
  };

  const results = await Promise.all([makeService().ingest(input), makeService().ingest(input)]);
  assert.equal(results.filter((result) => result.stored.length === 1).length, 2);
  assert.equal(results[0]?.stored[0]?.objectKey, results[1]?.stored[0]?.objectKey);
  assert.equal(uploads.length, 2);
  assert.notEqual(uploads[0], uploads[1]);
  assert.equal(removed.length, 1);
  assert.notEqual(removed[0], saved[0]?.objectKey);
  assert.equal(saved.length, 1);
});
