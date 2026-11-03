import assert from "node:assert/strict";
import test from "node:test";
import type { Content, Product, SocialAccount } from "@affiliateos/shared";
import type { MediaAsset } from "../../src/domain/media-asset.js";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "../../src/domain/product-media-ingestion.js";
import { ContentService } from "../../src/domain/content.js";
import { PublisherExecutor } from "../../src/domain/publisher-executor.js";
import {
  InMemoryMediaAssetRepository,
  InMemoryProductCatalogRepository,
  InMemoryRepository,
  InMemorySocialAccountRepository
} from "../../src/domain/repository.js";
import type { SocialPublisher } from "../../src/domain/distribution-engine.js";

const productId = "33333333-3333-4333-8333-333333333333";
const contentId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";

const product: Product = {
  id: productId, marketplaceId: "marketplace-1", externalProductId: "external-1", name: "Demo Product",
  priceCents: 10000, currency: "USD", reviewCount: 10, soldCount: 50,
  productUrl: "https://example.com/product", status: "active",
  createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z"
};
const account: SocialAccount = {
  id: "tiktok-account", platform: "tiktok", accountReference: "tiktok-ref", status: "active", connection: {},
  createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z"
};
const content: Content = {
  id: contentId, productId, platform: "tiktok", contentType: "affiliate-promotion", status: "scheduled",
  mediaAssetIds: [mediaId], scheduledAt: "2026-11-02T00:00:00.000Z",
  createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z"
};
const media: MediaAsset = {
  id: mediaId, contentId, kind: "video", source: "object-storage",
  reference: `affiliate-media/products/${productId}/video.mp4`, mimeType: "video/mp4", byteSize: 123,
  createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z"
};
const productMedia = (rightsStatus: ProductMediaAsset["rightsStatus"]): ProductMediaAsset => ({
  id: "44444444-4444-4444-8444-444444444444", productId, kind: "video",
  bucket: "affiliate-media", objectKey: `products/${productId}/video.mp4`, mimeType: "video/mp4",
  byteSize: 123, sha256: "a".repeat(64), sourceUrl: "https://cdn.example.test/video.mp4",
  sourcePublisher: "Verified publisher", rightsStatus, rightsBasis: "explicit_permission",
  rightsEvidenceUrl: "https://publisher.example.test/permission",
  rightsVerifiedAt: "2026-11-02T00:00:00.000Z", createdAt: "2026-11-02T00:00:00.000Z"
});

async function setup(rightsStatus: ProductMediaAsset["rightsStatus"], mediaOverride: MediaAsset = media) {
  const contents = new InMemoryRepository<Content>();
  await contents.save(content);
  const products = new InMemoryProductCatalogRepository();
  await products.save(product);
  const contentService = new ContentService(contents, new InMemoryRepository<any>(), products);
  const socialAccounts = new InMemorySocialAccountRepository();
  await socialAccounts.save(account);
  const mediaAssets = new InMemoryMediaAssetRepository();
  await mediaAssets.save(mediaOverride);
  const contentProducts = {
    async listByContent() { return [{ contentId, productId, position: 0, role: "primary" as const, createdAt: content.createdAt }]; },
    async replaceForContent() { return []; }
  };
  const productMediaAssets: ProductMediaAssetRepository = {
    async findByProductAndHash() { return undefined; },
    async listByProduct(id) { return id === productId ? [productMedia(rightsStatus)] : []; },
    async listByProducts(ids) { return ids.includes(productId) ? [productMedia(rightsStatus)] : []; },
    async save(asset) { return asset; }
  };
  let providerCalls = 0;
  const publisher: SocialPublisher = {
    provider: "test-publisher",
    supports: () => true,
    async publish({ mediaAssets: sent }) {
      providerCalls += 1;
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.source, "url");
      return { externalPostId: "external-post-1" };
    }
  };
  const storage = {
    bucketName: "affiliate-media",
    async createSignedUrl() { return "https://project.supabase.co/storage/v1/object/sign/affiliate-media/video.mp4?token=temporary"; }
  };
  const executor = new PublisherExecutor(
    contentService, socialAccounts, [publisher], undefined, mediaAssets, undefined, storage,
    contentProducts, productMediaAssets
  );
  return { executor, contentService, getProviderCalls: () => providerCalls };
}

test("preserves the existing TikTok URL-media path while product-media rights remain unverified", async () => {
  const legacyUrlMedia: MediaAsset = {
    ...media,
    source: "url",
    reference: "https://cdn.example.test/legacy-tiktok-video.mp4"
  };
  const legacy = await setup("unverified", legacyUrlMedia);
  const result = await legacy.executor.execute(contentId, new Date("2026-11-02T01:00:00.000Z"));
  assert.equal(result.status, "published");
  assert.equal(legacy.getProviderCalls(), 1);
});

test("publisher re-reads current product-media rights immediately before provider dispatch", async () => {
  const unverified = await setup("unverified");
  await assert.rejects(
    unverified.executor.execute(contentId, new Date("2026-11-02T01:00:00.000Z")),
    /rights are missing, ambiguous, unverified, or revoked/
  );
  assert.equal(unverified.getProviderCalls(), 0);

  const verified = await setup("verified");
  const result = await verified.executor.execute(contentId, new Date("2026-11-02T01:00:00.000Z"));
  assert.equal(result.status, "published");
  assert.equal(verified.getProviderCalls(), 1);
});
