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
