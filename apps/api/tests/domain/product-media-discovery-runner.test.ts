import assert from "node:assert/strict";
import test from "node:test";
import type { Product } from "@affiliateos/shared";
import { ProductMediaDiscoveryRunner } from "../../src/domain/product-media-discovery-runner.js";
import type { ProductMediaAsset } from "../../src/domain/product-media-ingestion.js";

const product: Product = {
  id: "11111111-1111-4111-8111-111111111111", marketplaceId: "market-1", externalProductId: "external-1",
  name: "Demo product", priceCents: 1000, currency: "IDR", reviewCount: 10, soldCount: 100,
  productUrl: "https://shop.example.test/product/1", status: "active",
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z"
};

const mp4 = new Uint8Array([
  0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 112, 52, 0, 0,
  0, 9, 109, 100, 97, 116, 1
]);

test("discovers, validates, and stores a public product video", async () => {
  const assets: ProductMediaAsset[] = [];
  const repository = {
    async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
    async findByProductAndHash(id: string, hash: string) { return assets.find((asset) => asset.productId === id && asset.sha256 === hash); },
    async save(asset: ProductMediaAsset) { assets.push(asset); return asset; }
  };
  const uploads: string[] = [];
  const storage = {
    async upload(input: { key: string }) { uploads.push(input.key); return { bucket: "affiliate-media", key: input.key }; },
    async remove() {}
  };
  const fetcher = async (url: string) => url.includes("/product/")
    ? { url, status: 200, headers: { "content-type": "text/html" }, bytes: new TextEncoder().encode('<meta property="og:video" content="https://cdn.example.test/video.mp4">') }
    : { url, status: 200, headers: { "content-type": "video/mp4" }, bytes: mp4 };
  const runner = new ProductMediaDiscoveryRunner(storage as never, repository, { maxImageBytes: 1024, maxVideoBytes: 1024 }, fetcher as never);
  const result = await runner.discover(product, true);
  assert.equal(result.pageFetched, true);
  assert.equal(result.hasVideo, true);
  assert.equal(assets.length, 1);
  assert.equal(assets[0]?.kind, "video");
  assert.equal(uploads.length, 1);
  assert.equal(await runner.hasStoredVideo(product.id), true);
});

test("refuses discovery before non-media eligibility passes", async () => {
  let fetched = false;
  const runner = new ProductMediaDiscoveryRunner({ upload: async () => ({ bucket: "b", key: "k" }), remove: async () => {} } as never, {
    async listByProduct() { return []; }, async findByProductAndHash() { return undefined; }, async save(asset: ProductMediaAsset) { return asset; }
  }, { maxImageBytes: 1024, maxVideoBytes: 1024 }, (async () => { fetched = true; throw new Error("should not fetch"); }) as never);
  await assert.rejects(() => runner.discover(product, false), /must pass non-media affiliate eligibility/);
  assert.equal(fetched, false);
});
