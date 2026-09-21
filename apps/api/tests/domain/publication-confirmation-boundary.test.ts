import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Content, Product, SocialAccount } from "@affiliateos/shared";
import type { SocialPublisher } from "../../src/domain/distribution-engine.js";
import { ContentService } from "../../src/domain/content.js";
import { PublisherExecutor } from "../../src/domain/publisher-executor.js";
import { PublicationJobService } from "../../src/domain/publication-job-service.js";
import { InMemoryPublicationJobRepository } from "../../src/domain/publication-job.js";
import { PublicationWorker } from "../../src/domain/publication-worker.js";
import { InMemoryPublicationOperationRepository } from "../../src/domain/publication-operation.js";
import { InMemoryProductCatalogRepository, InMemoryRepository, InMemorySocialAccountRepository } from "../../src/domain/repository.js";

const product: Product = {
  id: "product-confirmation-1", marketplaceId: "marketplace-1", externalProductId: "external-confirmation-1",
  name: "Confirmation Product", priceCents: 10000, currency: "USD", reviewCount: 10, soldCount: 50,
  productUrl: "https://example.com/product", status: "active",
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};

const account: SocialAccount = {
  id: "confirmation-account", platform: "tiktok", accountReference: "confirmation-ref",
  status: "active", connection: {}, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};

describe("Publication confirmation boundary", () => {
  it("does not republish when an accepted provider cannot be queried for status", async () => {
    const contents = new InMemoryRepository<Content>();
    const campaigns = new InMemoryRepository<any>();
    const products = new InMemoryProductCatalogRepository();
    await products.save(product);
    const contentService = new ContentService(contents, campaigns, products);
    const socialAccounts = new InMemorySocialAccountRepository();
    await socialAccounts.save(account);
    const jobs = new InMemoryPublicationJobRepository();
    const jobService = new PublicationJobService(jobs);
    const operations = new InMemoryPublicationOperationRepository();
    const content = await contentService.create({
      productId: product.id, platform: "tiktok", contentType: "affiliate-promotion",
      status: "scheduled", scheduledAt: "2026-09-20T10:00:00.000Z"
    });

    let publishes = 0;
    const publisher: SocialPublisher = {
      provider: "no-status-check-provider",
      supports: () => true,
      publish: async () => {
        publishes += 1;
        return { status: "accepted", providerOperationId: "unknown-operation-1" };
      }
    };

    const worker = new PublicationWorker(
      jobs,
      jobService,
      new PublisherExecutor(contentService, socialAccounts, [publisher]),
      contentService,
      operations
    );

    const job = await jobService.enqueue(content);
    const accepted = await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(accepted[0]?.status, "awaiting_confirmation");
    assert.equal((await jobs.findById(job.id))?.status, "awaiting_confirmation");
    assert.equal((await operations.findByProviderOperation("no-status-check-provider", "unknown-operation-1"))?.status, "awaiting_confirmation");
    assert.equal((await contentService.get(content.id)).status, "scheduled");

    const later = await worker.runOnce(new Date("2026-09-20T13:00:00.000Z"));
    assert.deepEqual(later, []);
    assert.equal(publishes, 1);

    const operation = (await operations.list())[0];
    const resolved = await worker.resolveConfirmation(operation.id, { status: "published", externalPostId: "manually-confirmed-post" }, new Date("2026-09-20T14:00:00.000Z"));
    assert.deepEqual(resolved, { jobId: job.id, contentId: content.id, status: "succeeded", externalPostId: "manually-confirmed-post" });
    assert.equal((await jobs.findById(job.id))?.status, "succeeded");
    assert.equal((await contentService.get(content.id)).status, "published");
    assert.equal((await operations.findByProviderOperation("no-status-check-provider", "unknown-operation-1"))?.status, "published");
  });
});
