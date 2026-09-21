import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Content, Product, SocialAccount } from "@affiliateos/shared";
import { ContentService } from "../../src/domain/content.js";
import { PublisherExecutor } from "../../src/domain/publisher-executor.js";
import { PublicationJobService } from "../../src/domain/publication-job-service.js";
import { InMemoryPublicationJobRepository } from "../../src/domain/publication-job.js";
import { PublicationWorker, publicationRetryDelayMs } from "../../src/domain/publication-worker.js";
import type { SocialPublisher } from "../../src/domain/distribution-engine.js";
import { InMemoryProductCatalogRepository, InMemoryRepository, InMemorySocialAccountRepository } from "../../src/domain/repository.js";
import { InMemoryPublicationOperationRepository } from "../../src/domain/publication-operation.js";

const product: Product = {
  id: "product-1", marketplaceId: "marketplace-1", externalProductId: "external-1", name: "Demo Product",
  priceCents: 10000, currency: "USD", reviewCount: 10, soldCount: 50, productUrl: "https://example.com/product", status: "active",
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};

const account: SocialAccount = {
  id: "tiktok-account", platform: "tiktok", accountReference: "tiktok-ref", status: "active", connection: {},
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};

const setup = async (scheduledAt = "2026-09-20T10:00:00.000Z") => {
  const contents = new InMemoryRepository<Content>();
  const campaigns = new InMemoryRepository<any>();
  const products = new InMemoryProductCatalogRepository();
  await products.save(product);
  const contentService = new ContentService(contents, campaigns, products);
  const socialAccounts = new InMemorySocialAccountRepository();
  await socialAccounts.save(account);
  const jobs = new InMemoryPublicationJobRepository();
  const jobService = new PublicationJobService(jobs);
  const content = await contentService.create({ productId: product.id, platform: "tiktok", contentType: "affiliate-promotion", status: "scheduled", scheduledAt });
  return { contentService, socialAccounts, jobs, jobService, content };
};

const workerFor = (contentService: ContentService, socialAccounts: InMemorySocialAccountRepository, jobs: InMemoryPublicationJobRepository, jobService: PublicationJobService, publishers: SocialPublisher[] = [], operationRepository?: import("../../src/domain/publication-operation.js").PublicationOperationRepository) =>
  new PublicationWorker(jobs, jobService, new PublisherExecutor(contentService, socialAccounts, publishers), contentService, operationRepository);

describe("PublicationWorker", () => {
  it("claims and completes a due publication job", async () => {
    const { contentService, socialAccounts, jobs, jobService, content } = await setup();
    let publishes = 0;
    const publisher: SocialPublisher = {
      supports: (platform) => platform === "tiktok",
      publish: async () => { publishes += 1; return { externalPostId: "external-post-1", status: "published" }; }
    };
    const worker = workerFor(contentService, socialAccounts, jobs, jobService, [publisher]);
    const job = await jobService.enqueue(content);
    const results = await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    const stored = await jobs.findById(job.id);
    assert.deepEqual(results[0], { jobId: job.id, contentId: content.id, status: "succeeded", externalPostId: "external-post-1" });
    assert.equal(stored?.status, "succeeded");
    assert.equal(stored?.attemptCount, 1);
    assert.equal(publishes, 1);
  });

  it("uses the content-bound social account when multiple accounts share a platform", async () => {
    const { contentService, socialAccounts, jobs, jobService } = await setup();
    const bound = { ...account, id: "bound-account", accountReference: "bound-ref" };
    const fallback = { ...account, id: "other-account", accountReference: "other-ref" };
    await socialAccounts.save(bound);
    await socialAccounts.save(fallback);
    const content = await contentService.create({ productId: product.id, platform: "tiktok", contentType: "affiliate-promotion", status: "scheduled", scheduledAt: "2026-09-20T10:00:00.000Z", socialAccountId: bound.id });
    let selectedAccount: string | undefined;
    const publisher: SocialPublisher = {
      supports: () => true,
      publish: async ({ account: selected }) => {
        selectedAccount = selected.id;
        return { externalPostId: "bound-post", status: "published" };
      }
    };
    const worker = workerFor(contentService, socialAccounts, jobs, jobService, [publisher]);
    await jobService.enqueue(content);
    const results = await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(results[0]?.status, "succeeded");
    assert.equal(selectedAccount, bound.id);
  });

  it("waits for an accepted provider operation before publishing content", async () => {
    const { contentService, socialAccounts, jobs, jobService, content } = await setup();
    let checks = 0;
    const publisher: SocialPublisher = {
      provider: "test-provider",
      supports: () => true,
      publish: async () => ({ status: "accepted", providerOperationId: "operation-1" }),
      checkPublication: async () => {
        checks += 1;
        return checks === 1 ? { status: "processing" } : { status: "published", externalPostId: "external-post-async" };
      }
    };
    const operations = new InMemoryPublicationOperationRepository();
    const worker = workerFor(contentService, socialAccounts, jobs, jobService, [publisher], operations);
    const job = await jobService.enqueue(content);
    const first = await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(first.at(-1)?.status, "awaiting_confirmation");
    assert.equal((await jobs.findById(job.id))?.status, "awaiting_confirmation");
    assert.equal((await contentService.get(content.id)).status, "scheduled");
    const blocked = await worker.runOnce(new Date("2026-09-20T11:01:00.000Z"));
    assert.deepEqual(blocked, []);
    assert.equal(checks, 0);
    const second = await worker.runOnce(new Date("2026-09-20T11:30:00.000Z"));
    assert.equal(second[0]?.status, "processing");
    const third = await worker.runOnce(new Date("2026-09-20T13:30:00.000Z"));
    assert.deepEqual(third[0], { jobId: job.id, contentId: content.id, status: "succeeded", externalPostId: "external-post-async" });
    assert.equal((await jobs.findById(job.id))?.status, "succeeded");
    assert.equal((await contentService.get(content.id)).status, "published");
  });

  it("reconciles an accepted operation after the worker instance is recreated", async () => {
    const { contentService, socialAccounts, jobs, jobService, content } = await setup();
    const operations = new InMemoryPublicationOperationRepository();
    let checks = 0;
    const publisher: SocialPublisher = {
      provider: "restart-safe-provider",
      supports: () => true,
      publish: async () => ({ status: "accepted", providerOperationId: "restart-safe-operation" }),
      checkPublication: async () => { checks += 1; return { status: "published", externalPostId: "restart-safe-post" }; }
    };
    const firstWorker = workerFor(contentService, socialAccounts, jobs, jobService, [publisher], operations);
    const job = await jobService.enqueue(content);
    const accepted = await firstWorker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(accepted[0]?.status, "awaiting_confirmation");
    assert.equal((await operations.list()).length, 1);
    const restartedWorker = workerFor(contentService, socialAccounts, jobs, jobService, [publisher], operations);
    const recovered = await restartedWorker.runOnce(new Date("2026-09-20T11:30:00.000Z"));
    assert.deepEqual(recovered[0], { jobId: job.id, contentId: content.id, status: "succeeded", externalPostId: "restart-safe-post" });
    assert.equal(checks, 1);
    assert.equal((await jobs.findById(job.id))?.status, "succeeded");
    assert.equal((await contentService.get(content.id)).status, "published");
    assert.equal((await operations.findByProviderOperation("restart-safe-provider", "restart-safe-operation"))?.status, "published");
  });

  it("keeps terminal publication job reconciliation idempotent and rejects conflicting outcomes", async () => {
    const { contentService, socialAccounts, jobs, jobService, content } = await setup();
    const publisher: SocialPublisher = {
      supports: () => true,
      publish: async () => ({ status: "published", externalPostId: "stable-post" })
    };
    const worker = workerFor(contentService, socialAccounts, jobs, jobService, [publisher]);
    const job = await jobService.enqueue(content);
    await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    assert.equal((await jobs.findById(job.id))?.status, "succeeded");
    assert.deepEqual(await jobService.succeed(job.id, "stable-post", new Date("2026-09-20T11:01:00.000Z")), await jobs.findById(job.id));
    await assert.rejects(
      jobService.succeed(job.id, "different-post", new Date("2026-09-20T11:02:00.000Z")),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "PUBLICATION_JOB_CONFLICT"
    );
    await assert.rejects(
      jobService.fail(job.id, "late failure", new Date("2026-09-20T11:03:00.000Z")),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "PUBLICATION_JOB_CONFLICT"
    );
  });

  it("repairs downstream content and job state after terminal operation recovery", async () => {
    const { contentService, socialAccounts, jobs, jobService, content } = await setup();
    const operations = new InMemoryPublicationOperationRepository();
    let checks = 0;
    const publisher: SocialPublisher = {
      provider: "repair-provider",
      supports: () => true,
      publish: async () => ({ status: "accepted", providerOperationId: "repair-operation" }),
      checkPublication: async () => {
        checks += 1;
        return { status: "published", externalPostId: "repair-post" };
      }
    };
    const originalUpdate = contentService.update.bind(contentService);
    let failNextUpdate = true;
    contentService.update = async (...args: Parameters<ContentService["update"]>) => {
      if (failNextUpdate) {
        failNextUpdate = false;
        throw new Error("simulated downstream content failure");
      }
      return originalUpdate(...args);
    };

    const worker = workerFor(contentService, socialAccounts, jobs, jobService, [publisher], operations);
    const job = await jobService.enqueue(content);
    const accepted = await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(accepted[0]?.status, "awaiting_confirmation");

    await assert.rejects(
      worker.runOnce(new Date("2026-09-20T11:30:00.000Z")),
      /simulated downstream content failure/
    );
    assert.equal((await operations.findByProviderOperation("repair-provider", "repair-operation"))?.status, "published");
    assert.equal((await jobs.findById(job.id))?.status, "processing");
    assert.equal((await contentService.get(content.id)).status, "scheduled");

    const repaired = await worker.runOnce(new Date("2026-09-20T11:31:00.000Z"));
    assert.deepEqual(repaired[0], {
      jobId: job.id,
      contentId: content.id,
      status: "succeeded",
      externalPostId: "repair-post"
    });
    assert.equal(checks, 1);
    assert.equal((await jobs.findById(job.id))?.status, "succeeded");
    assert.equal((await contentService.get(content.id)).status, "published");
  });

  it("reuses the same publisher idempotency key after a crash-like retry", async () => {
    const { contentService, socialAccounts, jobs, jobService, content } = await setup();
    const keys: string[] = [];
    let attempts = 0;
    const publisher: SocialPublisher = {
      provider: "idempotent-provider",
      supports: () => true,
      publish: async ({ idempotencyKey }) => {
        keys.push(idempotencyKey);
        attempts += 1;
        if (attempts === 1) throw new Error("simulated interruption");
        return { status: "published", externalPostId: "idempotent-post" };
      }
    };
    const worker = workerFor(contentService, socialAccounts, jobs, jobService, [publisher]);
    const job = await jobService.enqueue(content);
    await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    await worker.runOnce(new Date("2026-09-20T11:01:00.000Z"));
    assert.equal(keys.length, 2);
    assert.equal(keys[0], job.idempotencyKey);
    assert.equal(keys[1], job.idempotencyKey);
    assert.equal((await jobs.findById(job.id))?.status, "succeeded");
  });

  it("records adapter failures and restores failed content before retrying after backoff", async () => {
    const { contentService, socialAccounts, jobs, jobService, content } = await setup();
    let attempts = 0;
    const publisher: SocialPublisher = {
      supports: () => true,
      publish: async () => { attempts += 1; if (attempts === 1) throw new Error("temporary provider failure"); return { externalPostId: "external-post-2", status: "published" }; }
    };
    const worker = workerFor(contentService, socialAccounts, jobs, jobService, [publisher]);
    const job = await jobService.enqueue(content);
    const first = await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    assert.equal((await contentService.get(content.id)).status, "failed");
    const blocked = await worker.runOnce(new Date("2026-09-20T11:00:59.999Z"));
    const second = await worker.runOnce(new Date("2026-09-20T11:01:00.000Z"));
    const stored = await jobs.findById(job.id);
    assert.equal(first[0]?.status, "failed");
    assert.equal(first[0]?.error, "temporary provider failure");
    assert.deepEqual(blocked, []);
    assert.equal(second[0]?.status, "succeeded");
    assert.equal((await contentService.get(content.id)).status, "published");
    assert.equal(stored?.attemptCount, 2);
    assert.equal(stored?.status, "succeeded");
  });

  it("uses exponential retry delays capped at one hour", () => {
    assert.equal(publicationRetryDelayMs(0), 0);
    assert.equal(publicationRetryDelayMs(1), 60_000);
    assert.equal(publicationRetryDelayMs(2), 120_000);
    assert.equal(publicationRetryDelayMs(3), 240_000);
    assert.equal(publicationRetryDelayMs(20), 3_600_000);
  });

  it("recovers a stale processing job", async () => {
    const { contentService, socialAccounts, jobs, jobService, content } = await setup();
    let publishes = 0;
    const publisher: SocialPublisher = {
      supports: () => true,
      publish: async () => { publishes += 1; return { externalPostId: "external-post-recovered", status: "published" }; }
    };
    const worker = workerFor(contentService, socialAccounts, jobs, jobService, [publisher]);
    const job = await jobService.enqueue(content);
    await jobs.save({ ...job, status: "processing", attemptCount: 1, lockedAt: "2026-09-20T10:40:00.000Z", updatedAt: "2026-09-20T10:40:00.000Z" });
    const results = await worker.runOnce(new Date("2026-09-20T10:50:00.000Z"));
    const stored = await jobs.findById(job.id);
    assert.equal(results[0]?.status, "succeeded");
    assert.equal(stored?.attemptCount, 2);
    assert.equal(publishes, 1);
  });

  it("leaves future jobs untouched", async () => {
    const { contentService, socialAccounts, jobs, jobService, content } = await setup("2026-09-20T12:00:00.000Z");
    const worker = workerFor(contentService, socialAccounts, jobs, jobService);
    const job = await jobService.enqueue(content);
    const results = await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    const stored = await jobs.findById(job.id);
    assert.deepEqual(results, []);
    assert.equal(stored?.status, "pending");
    assert.equal(stored?.attemptCount, 0);
  });
});