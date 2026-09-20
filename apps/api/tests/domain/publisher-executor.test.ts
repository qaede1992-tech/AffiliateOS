import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Content, Product, SocialAccount } from "@affiliateos/shared";
import { ContentService } from "../../src/domain/content.js";
import { PublisherExecutor } from "../../src/domain/publisher-executor.js";
import type { SocialPublisher } from "../../src/domain/distribution-engine.js";
import { InMemorySocialCredentialResolver } from "../../src/domain/social-credentials.js";
import { InMemoryProductCatalogRepository, InMemoryRepository, InMemorySocialAccountRepository } from "../../src/domain/repository.js";

const product: Product = {
  id: "product-1", marketplaceId: "marketplace-1", externalProductId: "external-1", name: "Demo Product",
  priceCents: 10000, currency: "USD", reviewCount: 10, soldCount: 50, productUrl: "https://example.com/product", status: "active",
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};

const account: SocialAccount = {
  id: "tiktok-account", platform: "tiktok", accountReference: "tiktok-ref", status: "active", connection: {},
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};

const setup = async (credentialReference?: string) => {
  const contents = new InMemoryRepository<Content>();
  const campaigns = new InMemoryRepository<any>();
  const products = new InMemoryProductCatalogRepository();
  await products.save(product);
  const contentService = new ContentService(contents, campaigns, products);
  const created = await contentService.create({ productId: product.id, platform: "tiktok", contentType: "affiliate-promotion", status: "scheduled", scheduledAt: "2026-09-20T10:00:00.000Z" });
  const socialAccounts = new InMemorySocialAccountRepository();
  await socialAccounts.save({ ...account, credentialReference });
  return { contentService, socialAccounts, created };
};

describe("PublisherExecutor", () => {
  it("publishes due scheduled content through a matching publisher", async () => {
    const { contentService, socialAccounts, created } = await setup();
    let published = 0;
    const publisher: SocialPublisher = {
      supports: (platform) => platform === "tiktok",
      publish: async ({ content, account: target }) => {
        published += 1;
        assert.equal(content.id, created.id);
        assert.equal(target.id, account.id);
        return { externalPostId: "external-post-1" };
      }
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher]);
    const result = await executor.execute(created.id, new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(result.status, "published");
    assert.equal(result.externalPostId, "external-post-1");
    assert.equal(result.content.status, "published");
    assert.equal(result.content.publishedAt, "2026-09-20T11:00:00.000Z");
    assert.equal(published, 1);
  });

  it("resolves credentials by opaque reference and does not store the secret on the account", async () => {
    const { contentService, socialAccounts, created } = await setup("secret-ref-1");
    const resolver = new InMemorySocialCredentialResolver();
    const secret = { accessToken: "test-secret" };
    resolver.set("secret-ref-1", secret);
    let received: unknown;
    const publisher: SocialPublisher = {
      supports: () => true,
      publish: async ({ account: target, credential }) => {
        received = credential;
        assert.equal(target.credentialReference, "secret-ref-1");
        assert.equal((target as unknown as { accessToken?: string }).accessToken, undefined);
        return { externalPostId: "external-post-credential" };
      }
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher], resolver);
    await executor.execute(created.id, new Date("2026-09-20T11:00:00.000Z"));
    assert.deepEqual(received, secret);
  });

  it("fails closed when a credential reference has no configured resolver", async () => {
    const { contentService, socialAccounts, created } = await setup("secret-ref-missing");
    const publisher: SocialPublisher = {
      supports: () => true,
      publish: async () => ({ externalPostId: "should-not-publish" })
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher]);
    await assert.rejects(() => executor.execute(created.id, new Date("2026-09-20T11:00:00.000Z")), /credential resolution is not configured/);
    assert.equal((await contentService.get(created.id)).status, "failed");
  });

  it("propagates a stable idempotency key to the publisher", async () => {
    const { contentService, socialAccounts, created } = await setup();
    let receivedKey: string | undefined;
    const publisher: SocialPublisher = {
      supports: () => true,
      publish: async ({ idempotencyKey }) => {
        receivedKey = idempotencyKey;
        return { externalPostId: "external-post-idempotent" };
      }
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher]);
    await executor.execute(created.id, new Date("2026-09-20T11:00:00.000Z"), "publication-job:job-1");
    assert.equal(receivedKey, "publication-job:job-1");
  });

  it("does not require an active account before the scheduled time", async () => {
    const { contentService, socialAccounts, created } = await setup();
    await socialAccounts.save({ ...account, status: "inactive" });
    let published = false;
    const publisher: SocialPublisher = {
      supports: () => true,
      publish: async () => { published = true; return { externalPostId: "unexpected" }; }
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher]);
    const result = await executor.execute(created.id, new Date("2026-09-20T09:00:00.000Z"));
    assert.equal(result.status, "not_due");
    assert.equal(result.account, undefined);
    assert.equal(published, false);
    assert.equal(result.content.status, "scheduled");
  });

  it("fails closed when no publisher adapter exists", async () => {
    const { contentService, socialAccounts, created } = await setup();
    const executor = new PublisherExecutor(contentService, socialAccounts, []);
    const result = await executor.execute(created.id, new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(result.status, "unsupported");
    assert.equal(result.content.status, "scheduled");
  });

  it("marks content failed when an adapter rejects the publish", async () => {
    const { contentService, socialAccounts, created } = await setup();
    const publisher: SocialPublisher = {
      supports: () => true,
      publish: async () => { throw new Error("provider rejected request"); }
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher]);
    await assert.rejects(() => executor.execute(created.id, new Date("2026-09-20T11:00:00.000Z")), /provider rejected request/);
    assert.equal((await contentService.get(created.id)).status, "failed");
  });
});
