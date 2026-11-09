import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Content } from "@affiliateos/shared";
import { PublicationJobService } from "../../src/domain/publication-job-service.js";
import { InMemoryPublicationJobRepository, createPublicationJob } from "../../src/domain/publication-job.js";
import { InMemoryPublicationOperationRepository } from "../../src/domain/publication-operation.js";
import { PublicationWorker } from "../../src/domain/publication-worker.js";
import type { PublisherExecutor } from "../../src/domain/publisher-executor.js";

const content = (id: string, scheduledAt: string): Content => ({
  id,
  platform: "instagram",
  contentType: "affiliate-promotion",
  status: "scheduled",
  scheduledAt,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z"
} as Content);

const createWorker = (jobs: InMemoryPublicationJobRepository, operations = new InMemoryPublicationOperationRepository()) =>
  new PublicationWorker(jobs, new PublicationJobService(jobs), {} as PublisherExecutor, undefined, operations);

describe("PublicationWorker nextWakeAt", () => {
  it("returns the earliest due time across scheduled jobs, retries, stale locks, and provider operations", async () => {
    const jobs = new InMemoryPublicationJobRepository();
    const operations = new InMemoryPublicationOperationRepository();
    const pending = createPublicationJob(content("pending", "2026-09-21T10:04:00.000Z"));
    await jobs.save(pending);

    const failed = {
      ...createPublicationJob(content("failed", "2026-09-21T09:00:00.000Z")),
      status: "failed" as const,
      attemptCount: 2,
      updatedAt: "2026-09-21T10:00:00.000Z"
    };
    await jobs.save(failed);

    const processing = {
      ...createPublicationJob(content("processing", "2026-09-21T09:00:00.000Z")),
      status: "processing" as const,
      attemptCount: 1,
      lockedAt: "2026-09-21T09:55:00.000Z",
      updatedAt: "2026-09-21T09:55:00.000Z"
    };
    await jobs.save(processing);

    await operations.save({
      id: "operation-1",
      contentId: "content-op",
      jobId: "job-op",
      provider: "instagram-graph",
      providerOperationId: "container-1",
      status: "accepted",
      createdAt: "2026-09-21T10:01:00.000Z",
      updatedAt: "2026-09-21T10:01:00.000Z"
    });

    const worker = createWorker(jobs, operations);
    assert.equal((await worker.nextWakeAt())?.toISOString(), "2026-09-21T10:02:00.000Z");
  });

  it("ignores approval-waiting and terminal jobs and operations", async () => {
    const jobs = new InMemoryPublicationJobRepository();
    const operations = new InMemoryPublicationOperationRepository();
    await jobs.save({
      ...createPublicationJob(content("approval", "2026-09-21T10:00:00.000Z")),
      status: "pending_approval"
    });
    await jobs.save({
      ...createPublicationJob(content("succeeded", "2026-09-21T10:00:00.000Z")),
      status: "succeeded"
    });
    await operations.save({
      id: "operation-failed",
      contentId: "content-failed",
      jobId: "job-failed",
      provider: "tiktok",
      providerOperationId: "operation-failed",
      status: "failed",
      createdAt: "2026-09-21T09:00:00.000Z",
      updatedAt: "2026-09-21T09:00:00.000Z"
    });

    const worker = createWorker(jobs, operations);
    assert.equal(await worker.nextWakeAt(), undefined);
  });

  it("uses bounded repository wake lookups without loading publication history", async () => {
    const jobs = {
      nextWakeAt: async (lockTimeoutMs: number) => {
        assert.equal(lockTimeoutMs, 10 * 60 * 1000);
        return new Date("2026-09-21T10:05:00.000Z");
      },
      list: async () => { throw new Error("unbounded publication job history read"); }
    } as unknown as InMemoryPublicationJobRepository;
    const operations = {
      findEarliestReconciliationUpdatedAt: async () => "2026-09-21T10:00:00.000Z",
      list: async () => { throw new Error("unbounded publication operation history read"); }
    } as unknown as InMemoryPublicationOperationRepository;
    const worker = new PublicationWorker(
      jobs,
      new PublicationJobService(jobs),
      {} as PublisherExecutor,
      {} as never,
      operations
    );

    assert.equal((await worker.nextWakeAt())?.toISOString(), "2026-09-21T10:02:00.000Z");
  });
});
