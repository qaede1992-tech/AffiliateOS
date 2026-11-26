import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Content, Product, SocialAccount } from "@affiliateos/shared";
import { ContentService } from "../../src/domain/content.js";
import { PublisherExecutor } from "../../src/domain/publisher-executor.js";
import type { SocialPublisher } from "../../src/domain/distribution-engine.js";
import { InMemorySocialCredentialResolver } from "../../src/domain/social-credentials.js";
import { InMemoryMediaAssetRepository, InMemoryProductCatalogRepository, InMemoryRepository, InMemorySocialAccountRepository } from "../../src/domain/repository.js";
import { InMemoryPublicationDispatchReservationRepository } from "../../src/domain/publication-dispatch-reservation.js";

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
  it("fails closed when a publisher does not declare a stable provider", async () => {
    const { contentService, socialAccounts, created } = await setup();
    const publisher: SocialPublisher = {
      supports: () => true,
      publish: async () => ({ externalPostId: "should-not-publish" })
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher]);
    await assert.rejects(
      () => executor.execute(created.id, new Date("2026-09-20T11:00:00.000Z")),
      /stable provider identifier/
    );
    assert.equal((await contentService.get(created.id)).status, "scheduled");
  });

  it("fails closed when an affiliate promotion product becomes inactive before publication", async () => {
    const { contentService, socialAccounts, created } = await setup();
    const products = new InMemoryProductCatalogRepository();
    await products.save({ ...product, status: "inactive" });
    const contents = new InMemoryRepository<Content>();
    const campaigns = new InMemoryRepository<any>();
    const isolatedContentService = new ContentService(contents, campaigns, products);
    const scheduled: Content = { id: "content-inactive", productId: product.id, platform: "tiktok", contentType: "affiliate-promotion", status: "scheduled", scheduledAt: "2026-09-20T10:00:00.000Z", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" };
    await contents.save(scheduled);
    let published = false;
    const publisher: SocialPublisher = {
      provider: "test-publisher",
      supports: () => true,
      publish: async () => { published = true; return { externalPostId: "should-not-publish" }; }
    };
    const executor = new PublisherExecutor(isolatedContentService, socialAccounts, [publisher]);
    await assert.rejects(() => executor.execute(scheduled.id, new Date("2026-09-20T11:00:00.000Z")), /active product/);
    assert.equal(published, false);
    assert.equal((await isolatedContentService.get(scheduled.id)).status, "scheduled");
    void created;
  });

  it("publishes due scheduled content through a matching publisher", async () => {
    const { contentService, socialAccounts, created } = await setup();
    let published = 0;
    const publisher: SocialPublisher = {
      provider: "test-publisher",
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

  it("returns unsupported when a publisher supports the platform but not the content capability", async () => {
    const { contentService, socialAccounts, created } = await setup();
    let published = false;
    const publisher: SocialPublisher = {
      provider: "test-publisher",
      supports: (platform) => platform === "tiktok",
      supportsContent: (content) => content.contentType === "video",
      publish: async () => { published = true; return { externalPostId: "should-not-publish" }; }
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher]);
    const result = await executor.execute(created.id, new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(result.status, "unsupported");
    assert.equal(result.content.status, "scheduled");
    assert.equal(published, false);
  });

  it("preserves compatibility for publishers without an explicit content capability method", async () => {
    const { contentService, socialAccounts, created } = await setup();
    const publisher: SocialPublisher = {
      provider: "test-publisher",
      supports: () => true,
      publish: async () => ({ externalPostId: "external-post-compatible" })
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher]);
    const result = await executor.execute(created.id, new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(result.status, "published");
    assert.equal(result.externalPostId, "external-post-compatible");
  });

  it("publishes through the explicitly bound account when multiple accounts share a platform", async () => {
    const { contentService, socialAccounts, created } = await setup();
    const secondary: SocialAccount = {
      ...account,
      id: "tiktok-account-secondary",
      accountReference: "tiktok-secondary-ref"
    };
    await socialAccounts.save(secondary);
    const bound = await contentService.update(created.id, { socialAccountId: secondary.id });
    let publishedAccountId: string | undefined;
    const publisher: SocialPublisher = {
      provider: "test-publisher",
      supports: () => true,
      publish: async ({ account: target }) => {
        publishedAccountId = target.id;
        return { externalPostId: "external-post-bound" };
      }
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher]);
    const result = await executor.execute(bound.id, new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(result.status, "published");
    assert.equal(result.account?.id, secondary.id);
    assert.equal(publishedAccountId, secondary.id);
  });

  it("rejects a bound account that is inactive instead of falling back to another account", async () => {
    const { contentService, socialAccounts, created } = await setup();
    const secondary: SocialAccount = {
      ...account,
      id: "tiktok-account-secondary",
      accountReference: "tiktok-secondary-ref",
      status: "inactive"
    };
    await socialAccounts.save(secondary);
    const bound = await contentService.update(created.id, { socialAccountId: secondary.id });
    const publisher: SocialPublisher = {
      provider: "test-publisher",
      supports: () => true,
      publish: async () => ({ externalPostId: "should-not-publish" })
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher]);
    await assert.rejects(() => executor.execute(bound.id, new Date("2026-09-20T11:00:00.000Z")), /social account is not active/);
    assert.equal((await contentService.get(bound.id)).status, "scheduled");
  });

  it("rejects a bound account whose platform does not match the content", async () => {
    const { contentService, socialAccounts, created } = await setup();
    const instagram: SocialAccount = {
      ...account,
      id: "instagram-account",
      platform: "instagram",
      accountReference: "instagram-ref"
    };
    await socialAccounts.save(instagram);
    const bound = await contentService.update(created.id, { socialAccountId: instagram.id });
    const executor = new PublisherExecutor(contentService, socialAccounts, []);
    await assert.rejects(() => executor.execute(bound.id, new Date("2026-09-20T11:00:00.000Z")), /platform does not match content platform/);
    assert.equal((await contentService.get(bound.id)).status, "scheduled");
  });

  it("rejects a missing bound account instead of silently selecting another account", async () => {
    const { contentService, socialAccounts, created } = await setup();
    const bound = await contentService.update(created.id, { socialAccountId: "missing-account" });
    const publisher: SocialPublisher = {
      provider: "test-publisher",
      supports: () => true,
      publish: async () => ({ externalPostId: "should-not-publish" })
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher]);
    await assert.rejects(() => executor.execute(bound.id, new Date("2026-09-20T11:00:00.000Z")), /social account does not exist/);
    assert.equal((await contentService.get(bound.id)).status, "scheduled");
  });

  it("resolves credentials by opaque reference and does not store the secret on the account", async () => {
    const { contentService, socialAccounts, created } = await setup("secret-ref-1");
    const resolver = new InMemorySocialCredentialResolver();
    const secret = { accessToken: "test-secret" };
    resolver.set("secret-ref-1", secret);
    let received: unknown;
    const publisher: SocialPublisher = {
      provider: "test-publisher",
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
      provider: "test-publisher",
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
      provider: "test-publisher",
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
      provider: "test-publisher",
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
      provider: "test-publisher",
      supports: () => true,
      publish: async () => { throw new Error("provider rejected request"); }
    };
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher]);
    await assert.rejects(() => executor.execute(created.id, new Date("2026-09-20T11:00:00.000Z")), /provider rejected request/);
    assert.equal((await contentService.get(created.id)).status, "failed");
  });
  it("issues an illustrative delivery URL only after the Instagram dispatch reservation is active", async () => {
    const mediaRepository = new InMemoryMediaAssetRepository();
    const contents = new InMemoryRepository<Content>();
    const campaigns = new InMemoryRepository<any>();
    const products = new InMemoryProductCatalogRepository();
    const contentService = new ContentService(contents, campaigns, products, mediaRepository);
    const created = await contentService.create({
      platform: "instagram",
      contentType: "video",
      status: "scheduled",
      scheduledAt: "2026-09-20T10:00:00.000Z"
    });
    const mediaId = "media-illustrative-1";
    const creativeId = "33333333-3333-4333-8333-333333333333";
    await mediaRepository.save({
      id: mediaId,
      contentId: created.id,
      kind: "video",
      source: "object-storage",
      reference: `affiliate-media/content/${created.id}/${creativeId}-${"a".repeat(64)}.mp4`,
      mimeType: "video/mp4",
      byteSize: 128,
      durationSeconds: 12,
      widthPx: 720,
      heightPx: 1280,
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z"
    });
    await contentService.update(created.id, { mediaAssetIds: [mediaId] });

    const instagramAccount: SocialAccount = {
      ...account,
      id: "instagram-account",
      platform: "instagram",
      accountReference: "instagram-ref"
    };
    const socialAccounts = new InMemorySocialAccountRepository();
    await socialAccounts.save(instagramAccount);
    const reservations = new InMemoryPublicationDispatchReservationRepository();
    const order: string[] = [];
    const guard = {
      async validate(input: { content: Content; mediaAssets: Array<{ id: string }> }) {
        assert.equal(input.content.id, created.id);
        assert.equal(input.mediaAssets[0]?.id, mediaId);
        assert.equal(await reservations.findByJobProvider("job-illustrative", "instagram-graph"), undefined);
        order.push("guard");
        return new Set([mediaId]);
      }
    };
    const delivery = {
      async issueTokenForMediaAsset(receivedMediaId: string, contentId: string) {
        assert.equal(receivedMediaId, mediaId);
        assert.equal(contentId, created.id);
        const reservation = await reservations.findByJobProvider("job-illustrative", "instagram-graph");
        assert.equal(reservation?.state, "dispatching");
        order.push("token");
        return { creativeId, token: "opaque-token" };
      }
    };
    const publisher: SocialPublisher = {
      provider: "instagram-graph",
      supports: (platform) => platform === "instagram",
      publish: async ({ mediaAssets }) => {
        assert.equal(mediaAssets[0]?.source, "url");
        assert.equal(mediaAssets[0]?.reference, `https://api.example.com/api/v1/public/illustrative-media/${creativeId}?token=opaque-token`);
        order.push("publish");
        return { status: "accepted", providerOperationId: "instagram-container-1" };
      }
    };
    const executor = new PublisherExecutor(
      contentService,
      socialAccounts,
      [publisher],
      undefined,
      mediaRepository,
      undefined,
      undefined,
      undefined,
      undefined,
      reservations,
      { guard, delivery, publicBaseUrl: "https://api.example.com" } as never
    );
    const result = await executor.execute(
      created.id,
      new Date("2026-09-20T11:00:00.000Z"),
      "job-illustrative",
      undefined,
      "job-illustrative"
    );
    assert.equal(result.status, "accepted");
    assert.deepEqual(order, ["guard", "token", "publish"]);
  });

  it("fails the active reservation when local media resolution fails before the provider request", async () => {
    const mediaRepository = new InMemoryMediaAssetRepository();
    const contents = new InMemoryRepository<Content>();
    const campaigns = new InMemoryRepository<any>();
    const products = new InMemoryProductCatalogRepository();
    const contentService = new ContentService(contents, campaigns, products, mediaRepository);
    const created = await contentService.create({
      platform: "instagram",
      contentType: "video",
      status: "scheduled",
      scheduledAt: "2026-09-20T10:00:00.000Z"
    });
    const mediaId = "media-illustrative-failure";
    await mediaRepository.save({
      id: mediaId,
      contentId: created.id,
      kind: "video",
      source: "object-storage",
      reference: `affiliate-media/content/${created.id}/generated.mp4`,
      mimeType: "video/mp4",
      byteSize: 128,
      durationSeconds: 12,
      widthPx: 720,
      heightPx: 1280,
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z"
    });
    await contentService.update(created.id, { mediaAssetIds: [mediaId] });
    const socialAccounts = new InMemorySocialAccountRepository();
    await socialAccounts.save({ ...account, id: "instagram-account-failure", platform: "instagram" });
    const reservations = new InMemoryPublicationDispatchReservationRepository();
    let providerCalls = 0;
    const publisher: SocialPublisher = {
      provider: "instagram-graph",
      supports: (platform) => platform === "instagram",
      publish: async () => { providerCalls += 1; return { status: "accepted", providerOperationId: "unexpected" }; }
    };
    const executor = new PublisherExecutor(
      contentService,
      socialAccounts,
      [publisher],
      undefined,
      mediaRepository,
      undefined,
      undefined,
      undefined,
      undefined,
      reservations,
      {
        guard: { validate: async () => new Set([mediaId]) },
        delivery: { issueTokenForMediaAsset: async () => { throw new Error("local media unavailable"); } },
        publicBaseUrl: "https://api.example.com"
      } as never
    );
    await assert.rejects(
      executor.execute(created.id, new Date("2026-09-20T11:00:00.000Z"), "job-media-failure", undefined, "job-media-failure"),
      /local media unavailable/
    );
    const reservation = await reservations.findByJobProvider("job-media-failure", "instagram-graph");
    assert.equal(reservation?.state, "failed");
    assert.equal(providerCalls, 0);
  });

});
