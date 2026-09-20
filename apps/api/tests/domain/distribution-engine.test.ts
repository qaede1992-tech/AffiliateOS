import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Content, Product, SocialAccount } from "@affiliateos/shared";
import { ContentService } from "../../src/domain/content.js";
import { DistributionEngine } from "../../src/domain/distribution-engine.js";
import { InMemoryProductCatalogRepository, InMemoryRepository, InMemorySocialAccountRepository } from "../../src/domain/repository.js";

const product: Product = {
  id: "product-1", marketplaceId: "marketplace-1", externalProductId: "external-1", name: "Demo Product",
  priceCents: 10000, currency: "USD", reviewCount: 10, soldCount: 50, productUrl: "https://example.com/product", status: "active",
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};

const account = (platform: string, status: SocialAccount["status"] = "active"): SocialAccount => ({
  id: `${platform}-account`, platform, accountReference: `${platform}-ref`, status, connection: {}, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
});

describe("DistributionEngine", () => {
  it("schedules draft content onto an active matching social account", async () => {
    const contents = new InMemoryRepository<Content>();
    const campaigns = new InMemoryRepository<any>();
    const products = new InMemoryProductCatalogRepository();
    await products.save(product);
    const contentService = new ContentService(contents, campaigns, products);
    const created = await contentService.create({ productId: product.id, platform: "tiktok", contentType: "affiliate-promotion", title: "Demo", status: "draft" });
    const socialAccounts = new InMemorySocialAccountRepository();
    await socialAccounts.save(account("tiktok"));
    const engine = new DistributionEngine(contentService, socialAccounts);

    const result = await engine.schedule({ content: created, scheduledAt: "2026-09-21T10:00:00.000Z" });

    assert.equal(result.account.id, "tiktok-account");
    assert.equal(result.content.status, "scheduled");
    assert.equal(result.content.scheduledAt, "2026-09-21T10:00:00.000Z");
    assert.equal(result.publishable, false);
  });

  it("fails closed when no active matching account exists", async () => {
    const contents = new InMemoryRepository<Content>();
    const campaigns = new InMemoryRepository<any>();
    const products = new InMemoryProductCatalogRepository();
    await products.save(product);
    const contentService = new ContentService(contents, campaigns, products);
    const created = await contentService.create({ productId: product.id, platform: "instagram", contentType: "affiliate-promotion", status: "draft" });
    const socialAccounts = new InMemorySocialAccountRepository();
    await socialAccounts.save(account("instagram", "pending"));
    const engine = new DistributionEngine(contentService, socialAccounts);

    await assert.rejects(() => engine.schedule({ content: created, scheduledAt: "2026-09-21T10:00:00.000Z" }), /No active social account/);
  });

  it("does not bypass the content state machine", async () => {
    const contents = new InMemoryRepository<Content>();
    const campaigns = new InMemoryRepository<any>();
    const products = new InMemoryProductCatalogRepository();
    await products.save(product);
    const contentService = new ContentService(contents, campaigns, products);
    const created = await contentService.create({ productId: product.id, platform: "facebook", contentType: "affiliate-promotion", status: "scheduled", scheduledAt: "2026-09-21T10:00:00.000Z" });
    const socialAccounts = new InMemorySocialAccountRepository();
    await socialAccounts.save(account("facebook"));
    const engine = new DistributionEngine(contentService, socialAccounts);

    await assert.rejects(() => engine.schedule({ content: created, scheduledAt: "2026-09-22T10:00:00.000Z" }), /Only draft content/);
  });
});
