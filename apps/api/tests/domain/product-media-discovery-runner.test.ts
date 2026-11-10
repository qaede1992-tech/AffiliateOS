import assert from "node:assert/strict";
import test from "node:test";
import type { Product } from "@affiliateos/shared";
import { ProductMediaDiscoveryRunner } from "../../src/domain/product-media-discovery-runner.js";
import { resetOpenverseCircuitForTests } from "../../src/domain/openverse-provider-circuit.js";
import type { ProductMediaAsset } from "../../src/domain/product-media-ingestion.js";

const product: Product = {
  id: "11111111-1111-4111-8111-111111111111", marketplaceId: "market-1", externalProductId: "external-1",
  name: "Demo product", priceCents: 1000, currency: "IDR", reviewCount: 10, soldCount: 100,
  productUrl: "https://shop.example.test/product/1", status: "active",
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z"
};

const mp4 = new Uint8Array([
  0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 112, 52, 0, 0,
  0, 0, 0, 9, 109, 100, 97, 116, 1
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
    bucketName: "affiliate-media",
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
  const runner = new ProductMediaDiscoveryRunner({ bucketName: "b", upload: async () => ({ bucket: "b", key: "k" }), remove: async () => {} } as never, {
    async listByProduct() { return []; }, async findByProductAndHash() { return undefined; }, async save(asset: ProductMediaAsset) { return asset; }
  }, { maxImageBytes: 1024, maxVideoBytes: 1024 }, (async () => { fetched = true; throw new Error("should not fetch"); }) as never);
  await assert.rejects(() => runner.discover(product, false), /must pass non-media affiliate eligibility/);
  assert.equal(fetched, false);
});

test("never fetches Shopee product HTML for media extraction", async () => {
  let fetched = false;
  const assets: ProductMediaAsset[] = [];
  const repository = {
    async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
    async findByProductAndHash() { return undefined; },
    async save(asset: ProductMediaAsset) { assets.push(asset); return asset; }
  };
  const runner = new ProductMediaDiscoveryRunner(
    { bucketName: "b", upload: async () => ({ bucket: "b", key: "k" }), remove: async () => {} } as never,
    repository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 },
    (async () => { fetched = true; throw new Error("Shopee HTML fetch must not run"); }) as never
  );
  const result = await runner.discover({ ...product, productUrl: "https://shopee.co.id/product/123/456" }, true);
  assert.equal(fetched, false);
  assert.equal(result.pageFetched, false);
  assert.equal(result.hasVideo, false);
  assert.match(result.skipped[0]?.reason ?? "", /Shopee product-page media extraction is disabled/);
});

test("ingests explicitly supplied Shopee catalog images without fetching product HTML", async () => {
  const assets: ProductMediaAsset[] = [];
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l0sAAAAASUVORK5CYII=", "base64");
  const repository = {
    async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
    async findByProductAndHash(id: string, hash: string) { return assets.find((asset) => asset.productId === id && asset.sha256 === hash); },
    async save(asset: ProductMediaAsset) { assets.push(asset); return asset; }
  };
  const fetched: string[] = [];
  const runner = new ProductMediaDiscoveryRunner(
    { bucketName: "affiliate-media", upload: async (input: { key: string }) => ({ bucket: "affiliate-media", key: input.key }), remove: async () => {} } as never,
    repository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 },
    (async (url: string) => {
      fetched.push(url);
      return { url, status: 200, headers: { "content-type": "image/png" }, bytes: png };
    }) as never
  );
  const result = await runner.discover({ ...product, productUrl: "https://shopee.co.id/product/123/456", imageUrl: "https://cdn.example.test/catalog-image.png" }, true);
  assert.deepEqual(fetched, ["https://cdn.example.test/catalog-image.png"]);
  assert.equal(result.pageFetched, false);
  assert.equal(result.hasVideo, false);
  assert.equal(result.stored.length, 1);
  assert.equal(result.stored[0]?.kind, "image");
  assert.equal(result.stored[0]?.sourceUrl, "https://cdn.example.test/catalog-image.png");
});

test("never downloads Shopee-owned CDN image or video URLs supplied in a product catalog", async () => {
  const assets: ProductMediaAsset[] = [];
  const repository = {
    async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
    async findByProductAndHash() { return undefined; },
    async save(asset: ProductMediaAsset) { assets.push(asset); return asset; }
  };
  let fetched = false;
  const runner = new ProductMediaDiscoveryRunner(
    { bucketName: "affiliate-media", upload: async () => ({ bucket: "affiliate-media", key: "unexpected" }), remove: async () => {} } as never,
    repository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 },
    (async () => { fetched = true; throw new Error("Shopee-owned CDN must not be fetched"); }) as never
  );
  const result = await runner.discover({
    ...product,
    productUrl: "https://shopee.co.id/product/123/456",
    imageUrl: "https://cf.shopee.co.id/file/product-image.jpg",
    videoUrl: "https://down-id.img.susercontent.com/file/product-video.mp4"
  }, true);
  assert.equal(fetched, false);
  assert.equal(result.pageFetched, false);
  assert.equal(result.stored.length, 0);
  const blockedShopeeMedia = result.skipped.filter((item) => /Shopee-hosted media is not fetched automatically/.test(item.reason));
  assert.equal(blockedShopeeMedia.length, 2);
});

test("continues discovering catalog images when an existing video has unverified rights", async () => {
  const existingVideo: ProductMediaAsset = {
    id: "33333333-3333-4333-8333-333333333333",
    productId: product.id,
    kind: "video",
    bucket: "affiliate-media",
    objectKey: `products/${product.id}/existing-video.mp4`,
    mimeType: "video/mp4",
    byteSize: 32,
    sha256: "a".repeat(64),
    sourceUrl: "https://cdn.example.test/video.mp4",
    sourcePublisher: null,
    rightsStatus: "unverified",
    rightsBasis: null,
    rightsEvidenceUrl: null,
    rightsVerifiedAt: null,
    createdAt: "2026-10-30T00:00:00.000Z"
  };
  const assets: ProductMediaAsset[] = [existingVideo];
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l0sAAAAASUVORK5CYII=", "base64");
  const repository = {
    async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
    async findByProductAndHash(id: string, hash: string) { return assets.find((asset) => asset.productId === id && asset.sha256 === hash); },
    async save(asset: ProductMediaAsset) { assets.push(asset); return asset; }
  };
  const fetched: string[] = [];
  const runner = new ProductMediaDiscoveryRunner(
    { bucketName: "affiliate-media", upload: async (input: { key: string }) => ({ bucket: "affiliate-media", key: input.key }), remove: async () => {} } as never,
    repository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 },
    (async (url: string) => {
      fetched.push(url);
      return { url, status: 200, headers: { "content-type": "image/png" }, bytes: png };
    }) as never
  );

  const result = await runner.discover({
    ...product,
    productUrl: "https://shopee.co.id/product/123/456",
    imageUrl: "https://cdn.example.test/catalog-image.png"
  }, true);

  assert.deepEqual(fetched, ["https://cdn.example.test/catalog-image.png"]);
  assert.equal(result.pageFetched, false);
  assert.equal(result.hasVideo, true);
  assert.equal(assets.some((asset) => asset.kind === "image"), true);
  assert.equal(assets.find((asset) => asset.kind === "video")?.rightsStatus, "unverified");
});

test("lists stored video product ids with one bulk repository read", async () => {
  const secondProductId = "22222222-2222-4222-8222-222222222222";
  const assets: ProductMediaAsset[] = [
    {
      id: "33333333-3333-4333-8333-333333333333",
      productId: product.id,
      kind: "video",
      bucket: "affiliate-media",
      objectKey: `products/${product.id}/video.mp4`,
      mimeType: "video/mp4",
      byteSize: 32,
      sha256: "a".repeat(64),
      sourceUrl: "https://cdn.example.test/video.mp4",
      sourcePublisher: null,
      rightsStatus: "unverified",
      rightsBasis: null,
      rightsEvidenceUrl: null,
      rightsVerifiedAt: null,
      createdAt: "2026-10-30T00:00:00.000Z"
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      productId: secondProductId,
      kind: "image",
      bucket: "affiliate-media",
      objectKey: `products/${secondProductId}/image.jpg`,
      mimeType: "image/jpeg",
      byteSize: 32,
      sha256: "b".repeat(64),
      sourceUrl: "https://cdn.example.test/image.jpg",
      sourcePublisher: null,
      rightsStatus: "unverified",
      rightsBasis: null,
      rightsEvidenceUrl: null,
      rightsVerifiedAt: null,
      createdAt: "2026-10-30T00:00:00.000Z"
    }
  ];
  let bulkCalls = 0;
  let perProductCalls = 0;
  const repository = {
    async listByProduct() {
      perProductCalls += 1;
      throw new Error("The bulk lookup should avoid per-product reads.");
    },
    async listByProducts(productIds: string[]) {
      bulkCalls += 1;
      assert.deepEqual(productIds, [product.id, secondProductId]);
      return assets.filter((asset) => productIds.includes(asset.productId));
    },
    async findByProductAndHash() { return undefined; },
    async save(asset: ProductMediaAsset) { return asset; }
  };
  const storage = {
    bucketName: "affiliate-media",
    async upload(input: { key: string }) { return { bucket: "affiliate-media", key: input.key }; },
    async remove() {}
  };
  const runner = new ProductMediaDiscoveryRunner(
    storage as never,
    repository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 }
  );

  assert.deepEqual(await runner.listVideoProductIds([]), []);
  assert.equal(bulkCalls, 0);
  assert.deepEqual(
    await runner.listVideoProductIds([product.id, secondProductId, product.id]),
    [product.id]
  );
  assert.equal(bulkCalls, 1);
  assert.equal(perProductCalls, 0);
});


test("only treats media with complete verified rights evidence as publishable", async () => {
  const productIds = [
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888",
    "99999999-9999-4999-8999-999999999991",
    "99999999-9999-4999-8999-999999999992"
  ];
  const baseAsset = {
    id: "99999999-9999-4999-8999-999999999999",
    kind: "image" as const,
    bucket: "affiliate-media",
    objectKey: "products/test/image.jpg",
    mimeType: "image/jpeg",
    byteSize: 32,
    sha256: "c".repeat(64),
    sourceUrl: "https://cdn.example.test/image.jpg",
    sourcePublisher: "Example publisher",
    rightsBasis: "explicit_permission" as const,
    rightsEvidenceUrl: "https://publisher.example.test/permission",
    rightsVerifiedAt: "2026-11-02T00:00:00.000Z",
    createdAt: "2026-11-02T00:00:00.000Z"
  };
  const assets: ProductMediaAsset[] = [
    { ...baseAsset, productId: productIds[0]!, rightsStatus: "unverified" },
    { ...baseAsset, productId: productIds[1]!, rightsStatus: "revoked" },
    { ...baseAsset, productId: productIds[2]!, rightsStatus: "verified" },
    { ...baseAsset, productId: productIds[3]!, rightsStatus: "verified", rightsEvidenceUrl: null },
    { ...baseAsset, productId: productIds[4]!, rightsStatus: "verified", sourcePublisher: null },
    { ...baseAsset, productId: productIds[5]!, rightsStatus: "verified", sourcePublisher: "   " }
  ];
  const repository = {
    async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
    async listByProducts(ids: string[]) { return assets.filter((asset) => ids.includes(asset.productId)); },
    async findByProductAndHash() { return undefined; },
    async save(asset: ProductMediaAsset) { return asset; }
  };
  const runner = new ProductMediaDiscoveryRunner(
    { bucketName: "affiliate-media", upload: async () => ({ bucket: "affiliate-media", key: "unused" }), remove: async () => {} } as never,
    repository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 }
  );

  assert.deepEqual(await runner.listPublishableMediaProductIds(productIds), [productIds[2]]);
});


test("only treats videos with verified rights evidence as publishable while preserving readiness", async () => {
  const productIds = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  const shared = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    kind: "video" as const,
    bucket: "affiliate-media",
    objectKey: "products/test/video.mp4",
    mimeType: "video/mp4" as const,
    byteSize: 64,
    sha256: "d".repeat(64),
    sourceUrl: "https://cdn.example.test/video.mp4",
    sourcePublisher: "Example publisher",
    rightsBasis: "license" as const,
    rightsEvidenceUrl: "https://publisher.example.test/license",
    rightsVerifiedAt: "2026-11-02T00:00:00.000Z",
    createdAt: "2026-11-02T00:00:00.000Z"
  };
  const assets: ProductMediaAsset[] = [
    { ...shared, productId: productIds[0]!, rightsStatus: "unverified" },
    { ...shared, productId: productIds[1]!, rightsStatus: "verified" },
    { ...shared, productId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", rightsStatus: "verified", sourcePublisher: null }
  ];
  const repository = {
    async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
    async listByProducts(ids: string[]) { return assets.filter((asset) => ids.includes(asset.productId)); },
    async findByProductAndHash() { return undefined; },
    async save(asset: ProductMediaAsset) { return asset; }
  };
  const runner = new ProductMediaDiscoveryRunner(
    { bucketName: "affiliate-media", upload: async () => ({ bucket: "affiliate-media", key: "unused" }), remove: async () => {} } as never,
    repository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 }
  );

  assert.deepEqual(await runner.listVideoProductIds(productIds), productIds);
  assert.deepEqual(await runner.listPublishableVideoProductIds([...productIds, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"]), [productIds[1]]);
});


test("rejects future verification timestamps and credentialed evidence URLs during media selection", async () => {
  const productIds = [
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3"
  ];
  const base = {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    kind: "image" as const,
    bucket: "affiliate-media",
    objectKey: "products/test/image.jpg",
    mimeType: "image/jpeg",
    byteSize: 32,
    sha256: "e".repeat(64),
    sourceUrl: "https://cdn.example.test/image.jpg",
    sourcePublisher: "Example publisher",
    rightsStatus: "verified" as const,
    rightsBasis: "explicit_permission" as const,
    rightsEvidenceUrl: "https://publisher.example.test/permission",
    rightsVerifiedAt: "2026-11-01T00:00:00.000Z",
    createdAt: "2026-11-02T00:00:00.000Z"
  };
  const assets: ProductMediaAsset[] = [
    { ...base, productId: productIds[0]!, rightsVerifiedAt: new Date(Date.now() + 60_000).toISOString() },
    { ...base, productId: productIds[1]!, rightsEvidenceUrl: "https://reviewer:secret@publisher.example.test/permission" },
    { ...base, productId: productIds[2]!, rightsBasis: "unsupported" as ProductMediaAsset["rightsBasis"] }
  ];
  const repository = {
    async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
    async listByProducts(ids: string[]) { return assets.filter((asset) => ids.includes(asset.productId)); },
    async findByProductAndHash() { return undefined; },
    async save(asset: ProductMediaAsset) { return asset; }
  };
  const runner = new ProductMediaDiscoveryRunner(
    { bucketName: "affiliate-media", upload: async () => ({ bucket: "affiliate-media", key: "unused" }), remove: async () => {} } as never,
    repository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 }
  );

  assert.deepEqual(await runner.listPublishableMediaProductIds(productIds), []);
});

test("scores only current rights-verified persisted media for target platform readiness", async () => {
  const asset: ProductMediaAsset = {
    id: "asset-1", productId: product.id, kind: "image", bucket: "affiliate-media",
    objectKey: `products/${product.id}/image.jpg`, mimeType: "image/jpeg", byteSize: 1024,
    width: 1080, height: 1080, sha256: "hash", sourceUrl: "https://cdn.example.test/image.jpg",
    sourcePublisher: "Example", rightsStatus: "verified", rightsBasis: "user_owned",
    rightsEvidenceUrl: "https://example.test/rights", rightsVerifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  const repository = {
    async listByProduct() { return [asset]; },
    async findByProductAndHash() { return asset; },
    async save(value: ProductMediaAsset) { return value; }
  };
  const runner = new ProductMediaDiscoveryRunner(
    { bucketName: "affiliate-media", upload: async () => ({ bucket: "affiliate-media", key: "k" }), remove: async () => {} } as never,
    repository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 }
  );
  const scores = await runner.listMediaReadinessScores([product.id], ["tiktok"]);
  assert.equal(scores[product.id], 100);
  const revokedRunner = new ProductMediaDiscoveryRunner(
    { bucketName: "affiliate-media", upload: async () => ({ bucket: "affiliate-media", key: "k" }), remove: async () => {} } as never,
    { ...repository, async listByProduct() { return [{ ...asset, rightsStatus: "revoked" as const }]; } },
    { maxImageBytes: 1024, maxVideoBytes: 1024 }
  );
  const revokedScores = await revokedRunner.listMediaReadinessScores([product.id], ["tiktok"]);
  assert.equal(revokedScores[product.id], 0);
});


test("counts duplicate catalog candidates as discovered without reporting them as newly saved", async () => {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const messages: string[] = [];
  const catalogFetch = async () => new Response("{}", { status: 403 });
  globalThis.fetch = async () => new Response(JSON.stringify({
    query: {
      pages: [{
        title: "File:Cat food bag.jpg",
        imageinfo: [{
          url: "https://upload.wikimedia.org/wikipedia/commons/c/c1/cat-food.jpg",
          thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/cat-food.jpg/800px-cat-food.jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Cat_food_bag.jpg",
          mime: "image/jpeg",
          extmetadata: {
            LicenseShortName: { value: "CC0" },
            LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" },
            Artist: { value: "Example creator" }
          }
        }]
      }]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  console.info = (message?: unknown) => { messages.push(String(message)); };
  try {
    const runner = new ProductMediaDiscoveryRunner(
      { bucketName: "affiliate-media", upload: async () => ({ bucket: "affiliate-media", key: "unused" }), remove: async () => {} } as never,
      { async listByProduct() { return []; }, async findByProductAndHash() { return undefined; }, async save() { throw new Error("No asset ingestion expected"); } },
      { maxImageBytes: 1024, maxVideoBytes: 1024 },
      undefined,
      { async saveMany() { return []; } },
      { fetchImpl: catalogFetch as typeof fetch }
    );
    const result = await runner.discover({
      ...product,
      name: "cat food",
      productUrl: "https://shopee.co.id/product/123/456"
    }, true);
    assert.equal(result.candidatesFound, 1);
    const completed = messages.map((message) => JSON.parse(message) as Record<string, unknown>)
      .find((message) => message.event === "product_media_catalog_search_completed");
    assert.equal(completed?.acceptedCount, 1);
    assert.equal(completed?.savedCount, 0);
    assert.equal(completed?.alreadyPresentCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
  }
});


test("does not expose catalog persistence errors in discovery logs or skipped results", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    query: {
      pages: [{
        title: "File:Cat food bag.jpg",
        imageinfo: [{
          url: "https://upload.wikimedia.org/wikipedia/commons/c/c1/cat-food.jpg",
          thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/cat-food.jpg/800px-cat-food.jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Cat_food_bag.jpg",
          mime: "image/jpeg",
          extmetadata: {
            LicenseShortName: { value: "CC0" },
            LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" },
            Artist: { value: "Example creator" }
          }
        }]
      }]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    const runner = new ProductMediaDiscoveryRunner(
      { bucketName: "affiliate-media", upload: async () => ({ bucket: "affiliate-media", key: "unused" }), remove: async () => {} } as never,
      { async listByProduct() { return []; }, async findByProductAndHash() { return undefined; }, async save() { throw new Error("No asset ingestion expected"); } },
      { maxImageBytes: 1024, maxVideoBytes: 1024 },
      undefined,
      { async saveMany() { throw new Error("insert into product_media_candidates values ($1) -- private-media-index-marker"); } },
      { fetchImpl: (async () => new Response("{}", { status: 403 })) as typeof fetch }
    );
    const result = await runner.discover({
      ...product,
      name: "cat food",
      productUrl: "https://shopee.co.id/product/123/456"
    }, true);
    assert.equal(result.candidatesFound, 0);
    assert.ok(result.skipped.some((item) => item.reason === "catalog_persistence_failed"));
    assert.doesNotMatch(JSON.stringify(result) + warnings.join("\n"), /insert into|private-media-index-marker|\$1/);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});


test("classifies catalog persistence failures separately and keeps provider errors sanitized", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  globalThis.fetch = (async () => new Response(JSON.stringify({
    results: [{
      title: "Demo product",
      url: "https://media.openverse-demo.net/demo.jpg",
      foreign_landing_url: "https://catalog.openverse-demo.net/demo",
      license: "cc0",
      source: "Openverse"
    }]
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };

  try {
    const assets: ProductMediaAsset[] = [];
    const assetRepository = {
      async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
      async findByProductAndHash() { return undefined; },
      async save(asset: ProductMediaAsset) { assets.push(asset); return asset; }
    };
    const candidateRepository = {
      async saveMany() { throw new Error('relation "product_media_candidates" does not exist'); },
      async listPendingByProduct() { return []; }
    };
    const runner = new ProductMediaDiscoveryRunner(
      { bucketName: "affiliate-media", upload: async () => ({ bucket: "affiliate-media", key: "unused" }), remove: async () => {} } as never,
      assetRepository,
      { maxImageBytes: 1024, maxVideoBytes: 1024 },
      undefined,
      candidateRepository as never
    );
    const result = await runner.discover({
      ...product,
      productUrl: "https://shopee.co.id/product/123/456"
    }, true);
    const events = warnings.map((message) => JSON.parse(message) as Record<string, unknown>);
    assert.equal(events.some((event) => event.event === "product_media_catalog_persistence_failed"), true);
    assert.equal(events.some((event) => event.event === "product_media_catalog_search_failed"), false);
    assert.equal(result.skipped.some((item) => item.reason === "catalog_persistence_failed"), true);
    assert.equal(JSON.stringify(events).includes("product_media_candidates"), false);
    assert.equal(result.pageFetched, false);
    assert.equal(result.hasVideo, false);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});


test("persists catalog search cooldown and invalidates it when product identity changes", async () => {
  resetOpenverseCircuitForTests();
  const attempts = new Map<string, { fingerprint: string; nextRetryAt: string }>();
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return { ok: true, json: async () => ({ results: [] }) } as Response;
  };
  const attemptRepository = {
    async claim(input: { productId: string; fingerprint: string; now: string; leaseUntil: string }) {
      const current = attempts.get(input.productId);
      if (current && current.fingerprint === input.fingerprint && current.nextRetryAt > input.now) return false;
      attempts.set(input.productId, { fingerprint: input.fingerprint, nextRetryAt: input.leaseUntil });
      return true;
    },
    async complete(input: { productId: string; fingerprint: string; outcome: string; now: string; nextRetryAt: string }) {
      attempts.set(input.productId, { fingerprint: input.fingerprint, nextRetryAt: input.nextRetryAt });
    }
  };
  const assetRepository = {
    async listByProduct() { return []; },
    async findByProductAndHash() { return undefined; },
    async save(asset: ProductMediaAsset) { return asset; }
  };
  const runner = new ProductMediaDiscoveryRunner(
    { bucketName: "b", upload: async () => ({ bucket: "b", key: "k" }), remove: async () => {} } as never,
    assetRepository,
    { maxImageBytes: 1024, maxVideoBytes: 1024 },
    undefined,
    { async saveMany(records: unknown[]) { return records; } } as never,
    { fetchImpl },
    attemptRepository
  );
  const shopeeProduct = { ...product, productUrl: "https://shopee.co.id/product/123/456" };

  await runner.discover(shopeeProduct, true);
  await runner.discover(shopeeProduct, true);
  assert.equal(fetchCount, 1, "unchanged product should not repeat an empty catalog search");

  await runner.discover({ ...shopeeProduct, name: "Demo product updated" }, true);
  assert.equal(fetchCount, 2, "changed product identity should invalidate the old cooldown");
  resetOpenverseCircuitForTests();
});

test("stops repeating an Openverse 403 across products while retaining Wikimedia fallback", async () => {
  resetOpenverseCircuitForTests();
  const originalFetch = globalThis.fetch;
  let openverseCalls = 0;
  let wikimediaCalls = 0;
  const openverseFetch = async () => {
    openverseCalls += 1;
    return new Response("<html>Cloudflare challenge</html>", {
      status: 403,
      headers: {
        "content-type": "text/html; charset=UTF-8",
        "server": "cloudflare",
        "cf-ray": "test-ray"
      }
    });
  };
  globalThis.fetch = async () => {
    wikimediaCalls += 1;
    return new Response(JSON.stringify({
      query: {
        pages: [{
          title: "File:Cat food bag.jpg",
          imageinfo: [{
            url: "https://upload.wikimedia.org/wikipedia/commons/c/c1/cat-food.jpg",
            thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/cat-food.jpg/800px-cat-food.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Cat_food_bag.jpg",
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC0" },
              LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" },
              Artist: { value: "Example creator" }
            }
          }]
        }]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const assets: ProductMediaAsset[] = [];
    const assetRepository = {
      async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
      async findByProductAndHash(id: string, hash: string) {
        return assets.find((asset) => asset.productId === id && asset.sha256 === hash);
      },
      async save(asset: ProductMediaAsset) { assets.push(asset); return asset; }
    };
    const candidateRepository = {
      async saveMany(records: unknown[]) { return records; },
      async listPendingByProduct() { return []; }
    };
    const runner = new ProductMediaDiscoveryRunner(
      { bucketName: "affiliate-media", upload: async () => ({ bucket: "affiliate-media", key: "unused" }), remove: async () => {} } as never,
      assetRepository,
      { maxImageBytes: 1024, maxVideoBytes: 1024 },
      undefined,
      candidateRepository as never,
      { fetchImpl: openverseFetch as typeof fetch }
    );

    const first = await runner.discover({
      ...product,
      name: "cat food",
      productUrl: "https://shopee.co.id/product/123/456"
    }, true);
    const second = await runner.discover({
      ...product,
      id: "22222222-2222-4222-8222-222222222222",
      externalProductId: "external-2",
      name: "cat food",
      productUrl: "https://shopee.co.id/product/123/457"
    }, true);

    assert.equal(first.candidatesFound, 1);
    assert.equal(second.candidatesFound, 1);
    assert.equal(openverseCalls, 1, "the second product must not repeat a provider-wide 403 request");
    assert.equal(wikimediaCalls, 2, "each product must retain the Wikimedia fallback");
  } finally {
    globalThis.fetch = originalFetch;
    resetOpenverseCircuitForTests();
  }
});
