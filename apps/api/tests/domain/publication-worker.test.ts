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
      provider: "tiktok",
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
      provider: "tiktok",
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

  it("uses bounded publication job candidates when the repository provides them", async () => {
    const { contentService, socialAccounts, jobs, jobService } = await setup();
    let candidateReads = 0;
    const boundedJobs = {
      ...jobs,
      list: async () => { throw new Error("unbounded job listing should not be used"); },
      listClaimable: async () => {
        candidateReads += 1;
        return [];
      }
    } as import("../../src/domain/publication-job.js").PublicationJobRepository;
    const worker = workerFor(contentService, socialAccounts, boundedJobs, jobService);
    const results = await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    assert.deepEqual(results, []);
    assert.equal(candidateReads, 1);
  });

  it("uses bounded reconciliation candidates when the repository provides them", async () => {
    const { contentService, socialAccounts, jobs, jobService } = await setup();
    const operations = new InMemoryPublicationOperationRepository();
    let candidateReads = 0;
    const boundedRepository = {
      ...operations,
      list: async () => { throw new Error("unbounded operation listing should not be used"); },
      listReconciliationCandidates: async () => {
        candidateReads += 1;
        return [];
      }
    } as import("../../src/domain/publication-operation.js").PublicationOperationRepository;
    const worker = workerFor(contentService, socialAccounts, jobs, jobService, [], boundedRepository);
    const results = await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    assert.deepEqual(results, []);
    assert.equal(candidateReads, 1);
  });

  it("fails closed when an accepted operation cannot be reconciled", async () => {
    const { contentService, socialAccounts, jobs, jobService, content } = await setup();
    const publisher: SocialPublisher = {
      provider: "no-check-provider",
      supports: () => true,
      publish: async () => ({ status: "accepted", providerOperationId: "operation-no-check" })
    };
    const operations = new InMemoryPublicationOperationRepository();
    const worker = workerFor(contentService, socialAccounts, jobs, jobService, [publisher], operations);
    const job = await jobService.enqueue(content);
    const accepted = await worker.runOnce(new Date("2026-09-20T11:00:00.000Z"));
    assert.equal(accepted[0]?.status, "awaiting_confirmation");
    const recovered = await worker.runOnce(new Date("2026-09-20T11:03:00.000Z"));
    assert.equal(recovered[0]?.status, "failed");
    assert.match(recovered[0]?.error ?? "", /does not support publication status checks/);
    assert.equal((await jobs.findById(job.id))?.status, "failed");
    assert.equal((await operations.findByProviderOperation("no-check-provider", "operation-no-check"))?.status, "failed");
    assert.equal((await contentService.get(content.id)).status, "failed");
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
    const testNow = new Date("2026-09-20T11:00:00.000Z");
    const first = await worker.runOnce(testNow);
    assert.equal(first.at(-1)?.status, "awaiting_confirmation");
    assert.equal((await jobs.findById(job.id))?.status, "awaiting_confirmation");
    assert.equal((await contentService.get(content.id)).status, "scheduled");
    const blocked = await worker.runOnce(new Date(testNow.getTime() + 60_000));
    assert.deepEqual(blocked, []);
    assert.equal(checks, 0);
    const second = await worker.runOnce(new Date(testNow.getTime() + 30 * 60_000));
    assert.equal(second[0]?.status, "processing");
    const third = await worker.runOnce(new Date(testNow.getTime() + 150 * 60_000));
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

  it("does not regress a published operation when concurrent reconciliation has a stale failed check", async () => {
    const { contentService, socialAccounts, jobs, jobService, content } = await setup();
    const operations = new InMemoryPublicationOperationRepository();
    const job = await jobService.enqueue(content);
    await jobService.claim(job.id, new Date("2026-09-20T11:00:00.000Z"));
    await jobService.awaitConfirmation(job.id, new Date("2026-09-20T11:00:00.000Z"));
    const operation = await operations.save({
      id: "race-operation",
      contentId: content.id,
      jobId: job.id,
      provider: "race-provider",
      providerOperationId: "race-provider-operation",
      status: "accepted",
      createdAt: "2026-09-20T10:00:00.000Z",
      updatedAt: "2026-09-20T10:00:00.000Z"
    });

    let checks = 0;
    let releaseChecks!: () => void;
    const checksReady = new Promise<void>((resolve) => { releaseChecks = resolve; });
    const publisher: SocialPublisher = {
      provider: "race-provider",
      supports: () => true,
      publish: async () => ({ status: "accepted", providerOperationId: operation.providerOperationId }),
      checkPublication: async () => {
        const checkNumber = ++checks;
        if (checkNumber === 2) releaseChecks();
        await checksReady;
        return checkNumber === 2
          ? { status: "failed", error: "stale provider failure" }
          : { status: "published", externalPostId: "race-post" };
      }
    };

    const workerA = workerFor(contentService, socialAccounts, jobs, jobService, [publisher], operations);
    const workerB = workerFor(contentService, socialAccounts, jobs, jobService, [publisher], operations);
    const [resultA, resultB] = await Promise.all([
      workerA.runOnce(new Date("2026-09-20T11:03:00.000Z")),
      workerB.runOnce(new Date("2026-09-20T11:03:00.000Z"))
    ]);

    assert.equal(checks, 2);
    assert.ok([...resultA, ...resultB].some((result) => result.status === "succeeded"));
    assert.equal((await operations.findById(operation.id))?.status, "published");
    assert.equal((await jobs.findById(job.id))?.status, "succeeded");
    assert.equal((await contentService.get(content.id)).status, "published");
  });

  it("records adapter failures and restores failed content before retrying after backoff", async () => {
    const { contentService, socialAccounts, jobs, jobService, content } = await setup();
    let attempts = 0;
    const publisher: SocialPublisher = {
      provider: "tiktok",
      supports: () => true,
      publish: async () => { attempts += 1; if (attempts === 1) throw new Error("temporary provider failure"); return { externalPostId: "external-post-2", status: "published" }; }
    };
    const worker = workerFor(contentService, socialAccounts, jobs, jobService, [publisher]);
    const job = await jobService.enqueue(content);
    const testNow = new Date("2026-09-20T11:00:00.000Z");
    const first = await worker.runOnce(testNow);
    assert.equal((await contentService.get(content.id)).status, "failed");
    const blocked = await worker.runOnce(new Date(testNow.getTime() + 59_999));
    const second = await worker.runOnce(new Date(testNow.getTime() + 60_000));
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
      provider: "tiktok",
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