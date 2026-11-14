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
import type { SocialCredentialResolver } from "../../src/domain/social-credentials.js";

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
  byteSize: 123, sha256: "a".repeat(64), sourceUrl: "https://cdn.example.com/video.mp4",
  sourcePublisher: "Verified publisher", rightsStatus, rightsBasis: "explicit_permission",
  rightsEvidenceUrl: "https://publisher.example.com/permission",
  rightsVerifiedAt: "2026-11-02T00:00:00.000Z", createdAt: "2026-11-02T00:00:00.000Z"
});

async function setup(rightsStatus: ProductMediaAsset["rightsStatus"], configuredMedia: MediaAsset = media, credentialResolver?: SocialCredentialResolver) {
  const contents = new InMemoryRepository<Content>();
  await contents.save(content);
  const products = new InMemoryProductCatalogRepository();
  await products.save(product);
  const contentService = new ContentService(contents, new InMemoryRepository<any>(), products);
  const socialAccounts = new InMemorySocialAccountRepository();
  await socialAccounts.save(credentialResolver ? { ...account, credentialReference: "social-credential-1" } : account);
  const mediaAssets = new InMemoryMediaAssetRepository();
  await mediaAssets.save(configuredMedia);
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
  let providerCheckCalls = 0;
  const publisher: SocialPublisher = {
    provider: "test-publisher",
    supports: () => true,
    async publish({ mediaAssets: sent }) {
      providerCalls += 1;
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.source, "url");
      return { externalPostId: "external-post-1" };
    },
    async checkPublication() {
      providerCheckCalls += 1;
      return { status: "processing" };
    }
  };
  const storage = {
    bucketName: "affiliate-media",
    async createSignedUrl() { return "https://project.supabase.co/storage/v1/object/sign/affiliate-media/video.mp4?token=temporary"; }
  };
  const executor = new PublisherExecutor(
    contentService, socialAccounts, [publisher], credentialResolver, mediaAssets, undefined, storage,
    contentProducts, productMediaAssets
  );
  return { executor, contentService, getProviderCalls: () => providerCalls, getProviderCheckCalls: () => providerCheckCalls };
}

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


test("blocks registered product source URLs without current verified rights before provider dispatch", async () => {
  const productSourceUrl: MediaAsset = { ...media, source: "url", reference: "https://cdn.example.com/video.mp4" };
  const unverified = await setup("unverified", productSourceUrl);
  await assert.rejects(
    unverified.executor.execute(contentId, new Date("2026-11-02T01:00:00.000Z")),
    /rights are missing, ambiguous, unverified, or revoked/
  );
  assert.equal(unverified.getProviderCalls(), 0);

  const verified = await setup("verified", productSourceUrl);
  const result = await verified.executor.execute(contentId, new Date("2026-11-02T01:00:00.000Z"));
  assert.equal(result.status, "published");
  assert.equal(verified.getProviderCalls(), 1);
});

test("keeps legacy external URL media publishable without changing the TikTok dispatch path", async () => {
  const legacyUrl: MediaAsset = {
    ...media,
    source: "url",
    reference: "https://cdn.example.com/legacy-tiktok-video.mp4"
  };
  const fixture = await setup("unverified", legacyUrl);
  const result = await fixture.executor.execute(contentId, new Date("2026-11-02T01:00:00.000Z"));
  assert.equal(result.status, "published");
  assert.equal(fixture.getProviderCalls(), 1);
});

test("keeps legacy content-scoped storage media publishable while product media rights remain unverified", async () => {
  const legacyUpload: MediaAsset = {
    ...media,
    source: "object-storage",
    reference: `affiliate-media/content/${contentId}/legacy-tiktok-video.mp4`
  };
  const fixture = await setup("unverified", legacyUpload);
  const result = await fixture.executor.execute(contentId, new Date("2026-11-02T01:00:00.000Z"));
  assert.equal(result.status, "published");
  assert.equal(fixture.getProviderCalls(), 1);
});

test("checks product-media rights before resolving social credentials", async () => {
  let rejectedCredentialReads = 0;
  const rejectedResolver: SocialCredentialResolver = {
    async resolve() { rejectedCredentialReads += 1; return { accessToken: "test-only" }; }
  };
  const unverified = await setup("unverified", media, rejectedResolver);
  await assert.rejects(
    unverified.executor.execute(contentId, new Date("2026-11-02T01:00:00.000Z")),
    /rights are missing, ambiguous, unverified, or revoked/
  );
  assert.equal(rejectedCredentialReads, 0);
  assert.equal(unverified.getProviderCalls(), 0);

  let verifiedCredentialReads = 0;
  const verifiedResolver: SocialCredentialResolver = {
    async resolve() { verifiedCredentialReads += 1; return { accessToken: "test-only" }; }
  };
  const verified = await setup("verified", media, verifiedResolver);
  const result = await verified.executor.execute(contentId, new Date("2026-11-02T01:00:00.000Z"));
  assert.equal(result.status, "published");
  assert.equal(verifiedCredentialReads, 1);
  assert.equal(verified.getProviderCalls(), 1);
});


const reconciliationOperation = {
  id: "operation-1",
  jobId: "job-1",
  contentId,
  provider: "test-publisher",
  providerOperationId: "provider-operation-1",
  status: "accepted" as const,
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z"
};

test("validates configured media before resolving credentials during reconciliation", async () => {
  let credentialReads = 0;
  const resolver: SocialCredentialResolver = {
    async resolve() { credentialReads += 1; return { accessToken: "test-only" }; }
  };
  const mismatchedMedia = { ...media, contentId: "99999999-9999-4999-8999-999999999999" };
  const fixture = await setup("verified", mismatchedMedia, resolver);

  await assert.rejects(
    fixture.executor.check(reconciliationOperation),
    /does not belong to the content/
  );
  assert.equal(credentialReads, 0);
  assert.equal(fixture.getProviderCheckCalls(), 0);
});

test("resolves credentials and checks the provider after valid reconciliation media", async () => {
  let credentialReads = 0;
  const resolver: SocialCredentialResolver = {
    async resolve() { credentialReads += 1; return { accessToken: "test-only" }; }
  };
  const fixture = await setup("verified", media, resolver);

  const result = await fixture.executor.check(reconciliationOperation);
  assert.equal(result.result.status, "processing");
  assert.equal(credentialReads, 1);
  assert.equal(fixture.getProviderCheckCalls(), 1);
});
