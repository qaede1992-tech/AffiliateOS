import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Content, Product, SocialAccount } from "@affiliateos/shared";
import { ContentService } from "../../src/domain/content.js";
import { DistributionEngine, type SocialPublisher } from "../../src/domain/distribution-engine.js";
import { InMemoryProductCatalogRepository, InMemoryRepository, InMemorySocialAccountRepository } from "../../src/domain/repository.js";

const product: Product = {
  id: "product-1", marketplaceId: "marketplace-1", externalProductId: "external-1", name: "Demo Product",
  priceCents: 10000, currency: "USD", reviewCount: 10, soldCount: 50, productUrl: "https://example.com/product", status: "active",
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};
const account = (id: string, platform: string, status: SocialAccount["status"] = "active"): SocialAccount => ({ id, platform, accountReference: `${id}-ref`, status, connection: {}, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" });
const setup = async (platform: string, accounts: SocialAccount[]) => {
  const contents = new InMemoryRepository<Content>(); const campaigns = new InMemoryRepository<any>(); const products = new InMemoryProductCatalogRepository(); await products.save(product);
  const contentService = new ContentService(contents, campaigns, products); const created = await contentService.create({ productId: product.id, platform: platform as Content["platform"], contentType: "affiliate-promotion", title: "Demo", status: "draft" });
  const socialAccounts = new InMemorySocialAccountRepository(); for (const target of accounts) await socialAccounts.save(target); return { contentService, socialAccounts, created };
};
describe("DistributionEngine", () => {
  it("schedules draft content onto an active matching social account", async () => { const { contentService, socialAccounts, created } = await setup("tiktok", [account("tiktok-account", "tiktok")]); const engine = new DistributionEngine(contentService, socialAccounts); const result = await engine.schedule({ content: created, scheduledAt: "2026-09-21T10:00:00.000Z" }); assert.equal(result.account.id, "tiktok-account"); assert.equal(result.content.status, "scheduled"); assert.equal(result.content.socialAccountId, "tiktok-account"); assert.equal(result.publishable, false); });
  it("rejects affiliate promotion scheduling when the product is inactive", async () => {
    const contents = new InMemoryRepository<Content>();
    const campaigns = new InMemoryRepository<any>();
    const products = new InMemoryProductCatalogRepository();
    await products.save({ ...product, status: "inactive" });
    const contentService = new ContentService(contents, campaigns, products);
    const created = await contentService.create({ productId: product.id, platform: "tiktok", contentType: "affiliate-promotion", title: "Inactive", status: "draft" });
    const socialAccounts = new InMemorySocialAccountRepository();
    await socialAccounts.save(account("tiktok-account", "tiktok"));
    const engine = new DistributionEngine(contentService, socialAccounts);
    await assert.rejects(() => engine.schedule({ content: created, scheduledAt: "2026-09-21T10:00:00.000Z" }), /active product/);
    assert.equal((await contentService.get(created.id)).status, "draft");
  });

  it("reports publishable only when the publisher supports the content capability", async () => { const { contentService, socialAccounts, created } = await setup("tiktok", [account("tiktok-account", "tiktok")]); const publisher: SocialPublisher = { supports: (platform) => platform === "tiktok", supportsContent: (content) => content.contentType === "video", publish: async () => ({ externalPostId: "unused" }) }; const engine = new DistributionEngine(contentService, socialAccounts, [publisher]); const result = await engine.schedule({ content: created, scheduledAt: "2026-09-21T10:00:00.000Z" }); assert.equal(result.publishable, false); });
  it("keeps publishers without an explicit content capability method compatible", async () => { const { contentService, socialAccounts, created } = await setup("tiktok", [account("tiktok-account", "tiktok")]); const publisher: SocialPublisher = { supports: (platform) => platform === "tiktok", publish: async () => ({ externalPostId: "unused" }) }; const engine = new DistributionEngine(contentService, socialAccounts, [publisher]); const result = await engine.schedule({ content: created, scheduledAt: "2026-09-21T10:00:00.000Z" }); assert.equal(result.publishable, true); });
  it("binds explicitly selected account when multiple accounts share a platform", async () => { const { contentService, socialAccounts, created } = await setup("tiktok", [account("tiktok-a", "tiktok"), account("tiktok-b", "tiktok")]); const engine = new DistributionEngine(contentService, socialAccounts); const result = await engine.schedule({ content: created, accountId: "tiktok-b", scheduledAt: "2026-09-21T10:00:00.000Z" }); assert.equal(result.account.id, "tiktok-b"); assert.equal(result.content.socialAccountId, "tiktok-b"); });
  it("rejects an explicitly selected account from another platform", async () => { const { contentService, socialAccounts, created } = await setup("tiktok", [account("instagram-a", "instagram")]); const engine = new DistributionEngine(contentService, socialAccounts); await assert.rejects(() => engine.schedule({ content: created, accountId: "instagram-a", scheduledAt: "2026-09-21T10:00:00.000Z" }), /platform does not match/); });
  it("fails closed when no active matching account exists", async () => { const { contentService, socialAccounts, created } = await setup("instagram", [account("instagram-account", "instagram", "pending")]); const engine = new DistributionEngine(contentService, socialAccounts); await assert.rejects(() => engine.schedule({ content: created, scheduledAt: "2026-09-21T10:00:00.000Z" }), /No social account is available/); });
  it("does not bypass the content state machine", async () => { const contents = new InMemoryRepository<Content>(); const campaigns = new InMemoryRepository<any>(); const products = new InMemoryProductCatalogRepository(); await products.save(product); const contentService = new ContentService(contents, campaigns, products); const created = await contentService.create({ productId: product.id, platform: "facebook", contentType: "affiliate-promotion", status: "scheduled", scheduledAt: "2026-09-21T10:00:00.000Z" }); const socialAccounts = new InMemorySocialAccountRepository(); await socialAccounts.save(account("facebook-account", "facebook")); const engine = new DistributionEngine(contentService, socialAccounts); await assert.rejects(() => engine.schedule({ content: created, scheduledAt: "2026-09-22T10:00:00.000Z" }), /Only draft content/); });
  it("restores draft state when publication job enqueue fails", async () => { const { contentService, socialAccounts, created } = await setup("tiktok", [account("tiktok-account", "tiktok")]); const jobs = { enqueue: async () => { throw new Error("queue unavailable"); } } as any; const engine = new DistributionEngine(contentService, socialAccounts, [], jobs); await assert.rejects(() => engine.schedule({ content: created, scheduledAt: "2026-09-21T10:00:00.000Z" }), /queue unavailable/); const restored = await contentService.get(created.id); assert.equal(restored.status, "draft"); assert.equal(restored.scheduledAt, undefined); assert.equal(restored.socialAccountId, undefined); });
  it("preflights a batch without mutating any content", async () => {
    const first = await setup("tiktok", [account("tiktok-account", "tiktok")]);
    const second = await setup("instagram", [account("instagram-account", "instagram", "pending")]);
    const engine = new DistributionEngine(first.contentService, first.socialAccounts);
    await assert.rejects(() => engine.validateBatch([
      { content: first.created, scheduledAt: "2026-09-21T10:00:00.000Z" },
      { content: second.created, scheduledAt: "2026-09-21T10:00:00.000Z" }
    ]), /No social account is available/);
    assert.equal((await first.contentService.get(first.created.id)).status, "draft");
    assert.equal((await second.contentService.get(second.created.id)).status, "draft");
  });
});
