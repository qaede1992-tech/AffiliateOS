import assert from "node:assert/strict";
import test from "node:test";
import type { Campaign, Content, Product } from "@affiliateos/shared";
import { ContentService } from "../src/domain/content.js";
import { InMemoryMediaAssetRepository, InMemoryRepository } from "../src/domain/repository.js";

const productId = "11111111-1111-4111-8111-111111111111";
const contentId = "22222222-2222-4222-8222-222222222222";
const manualAssetId = "33333333-3333-4333-8333-333333333333";

function setup(options: { imageUrl?: string; videoUrl?: string; mediaAssetIds?: string[] } = {}) {
  const product: Product = {
    id: productId, marketplaceId: "44444444-4444-4444-8444-444444444444",
    externalProductId: "test-product", name: "Test product", priceCents: 1000,
    currency: "IDR", reviewCount: 0, soldCount: 0, productUrl: "https://shop.example/product",
    status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...(options.imageUrl === undefined ? {} : { imageUrl: options.imageUrl }),
    ...(options.videoUrl === undefined ? {} : { videoUrl: options.videoUrl })
  };
  const content: Content = {
    id: contentId, productId, platform: "instagram", contentType: "affiliate-promotion",
    status: "draft", mediaAssetIds: options.mediaAssetIds,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const contents = new InMemoryRepository<Content>();
  const products = new InMemoryRepository<Product>();
  const campaigns = new InMemoryRepository<Campaign>();
  const mediaAssets = new InMemoryMediaAssetRepository();
  contents.save(content);
  products.save(product);
  const service = new ContentService(contents, campaigns, products, mediaAssets);
  return { service, contents, mediaAssets, product, content };
}

test("attaches a product image URL and reuses it on repeated selection", async () => {
  const { service, mediaAssets, contentId } = setup({ imageUrl: "https://cdn.example/image.jpg" });
  const first = await service.attachProductMedia(contentId, ["image"]);
  const second = await service.attachProductMedia(contentId, ["image"]);
  assert.equal((await mediaAssets.listByContent(contentId)).length, 1);
  assert.deepEqual(first.attachedMediaAssetIds, second.attachedMediaAssetIds);
  assert.equal(second.content.mediaAssetIds?.length, 1);
});

test("attaches video URL without disturbing manually assigned media IDs", async () => {
  const { service, mediaAssets, contentId, contents, content } = setup({
    videoUrl: "https://cdn.example/video.mp4", mediaAssetIds: [manualAssetId]
  });
  await mediaAssets.save({
    id: manualAssetId, contentId, kind: "image", source: "url",
    reference: "https://cdn.example/manual.jpg",
    createdAt: content.createdAt, updatedAt: content.updatedAt
  });
  const result = await service.attachProductMedia(contentId, ["video"]);
  assert.deepEqual(result.content.mediaAssetIds, [manualAssetId, result.attachedMediaAssetIds[0]]);
  assert.equal((await mediaAssets.listByContent(contentId)).length, 2);
  assert.equal((await contents.findById(contentId))?.mediaAssetIds?.length, 2);
});

test("rejects a selected product media kind when its URL is missing", async () => {
  const { service, mediaAssets, contentId } = setup();
  await assert.rejects(
    service.attachProductMedia(contentId, ["image"]),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "PRODUCT_MEDIA_NOT_AVAILABLE")
  );
  assert.equal((await mediaAssets.listByContent(contentId)).length, 0);
});
