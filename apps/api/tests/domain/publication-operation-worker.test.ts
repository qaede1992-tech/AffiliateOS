import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Content, Product, SocialAccount } from "@affiliateos/shared";
import { ContentService } from "../../src/domain/content.js";
import { DistributionEngine, type SocialPublisher } from "../../src/domain/distribution-engine.js";
import { PublicationJobService } from "../../src/domain/publication-job-service.js";
import { InMemoryPublicationJobRepository } from "../../src/domain/publication-job.js";
import { InMemoryPublicationOperationRepository } from "../../src/domain/publication-operation.js";
import { PublicationWorker } from "../../src/domain/publication-worker.js";
import { PublisherExecutor } from "../../src/domain/publisher-executor.js";
import { InMemoryProductCatalogRepository, InMemoryRepository, InMemorySocialAccountRepository } from "../../src/domain/repository.js";

const product: Product = {
  id: "product-async", marketplaceId: "marketplace-async", externalProductId: "external-async", name: "Async Product",
  priceCents: 10000, currency: "USD", reviewCount: 1, soldCount: 2, productUrl: "https://example.com/async", status: "active",
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};

const account: SocialAccount = {
  id: "async-account", platform: "tiktok", accountReference: "async-ref", status: "active", connection: {},
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};

const setup = async () => {
  const contents = new InMemoryRepository<Content>();
  const campaigns = new InMemoryRepository<any>();
  const products = new InMemoryProductCatalogRepository();
  await products.save(product);
  const contentService = new ContentService(contents, campaigns, products);
  const socialAccounts = new InMemorySocialAccountRepository();
  await socialAccounts.save(account);
  const jobs = new InMemoryPublicationJobRepository();
  const operations = new InMemoryPublicationOperationRepository();
  const jobService = new PublicationJobService(jobs);
  const content = await contentService.create({ productId: product.id, platform: "tiktok", contentType: "affiliate-promotion", status: "draft" });
  await new DistributionEngine(contentService, socialAccounts, [], jobService).schedule({ content, scheduledAt: "2026-09-20T10:00:00.000Z", accountId: account.id });
  return { contentService, socialAccounts, jobs, operations, jobService, content: await contentService.get(content.id) };
};

describe("Publication operation lifecycle", () => {
  it("moves an accepted provider submission into awaiting confirmation without publishing content", async () => {
    const { contentService, socialAccounts, jobs, operations, jobService, content } = await setup();
    const publisher: SocialPublisher = {
      provider: "tiktok",
      supports: () => true,
      publish: async () => ({ status: "accepted", providerOperationId: "publish-123" }),
      checkPublication: async () => ({ status: "processing" })
    };
    const worker = new PublicationWorker(jobs, jobService, new PublisherExecutor(contentService, socialAccounts, [publisher]), contentService, operations);
    const job = await jobService.enqueue(content);

    const results = await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    const storedJob = await jobs.findById(job.id);
    const storedOperations = await operations.list();

    assert.equal(results[0]?.status, "awaiting_confirmation");
    assert.equal(storedJob?.status, "awaiting_confirmation");
    assert.equal(storedJob?.attemptCount, 1);
    assert.equal((await contentService.get(content.id)).status, "scheduled");
    assert.equal(storedOperations.length, 1);
    assert.equal(storedOperations[0]?.providerOperationId, "publish-123");
  });

  it("confirms a published provider operation and closes the job", async () => {
    const { contentService, socialAccounts, jobs, operations, jobService, content } = await setup();
    let checks = 0;
    const publisher: SocialPublisher = {
      provider: "tiktok",
      supports: () => true,
      publish: async () => ({ status: "accepted", providerOperationId: "publish-456" }),
      checkPublication: async () => {
        checks += 1;
        return { status: "published", externalPostId: "post-456" };
      }
    };
    const worker = new PublicationWorker(jobs, jobService, new PublisherExecutor(contentService, socialAccounts, [publisher]), contentService, operations);
    const job = await jobService.enqueue(content);

    await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    const results = await worker.runOnce(new Date("2026-09-20T11:01:00.000Z"));
    const storedJob = await jobs.findById(job.id);
    const storedOperation = (await operations.list())[0];
    const storedContent = await contentService.get(content.id);

    assert.equal(checks, 1);
    assert.equal(results[0]?.status, "succeeded");
    assert.equal(storedJob?.status, "succeeded");
    assert.equal(storedJob?.externalPostId, "post-456");
    assert.equal(storedOperation?.status, "published");
    assert.equal(storedContent.status, "published");
  });
});
