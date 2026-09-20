import type { EntityId } from "@affiliateos/shared";
import { PublisherExecutor } from "./publisher-executor.js";
import type { PublicationJob } from "./publication-job.js";
import { PublicationJobService } from "./publication-job-service.js";
import type { PublicationJobRepository } from "./publication-job.js";

const INITIAL_RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
export const PUBLICATION_JOB_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

export const publicationRetryDelayMs = (attemptCount: number): number => {
  if (attemptCount <= 0) return 0;
  return Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** (attemptCount - 1));
};

const retryEligibleAt = (job: PublicationJob): number =>
  new Date(job.updatedAt).getTime() + publicationRetryDelayMs(job.attemptCount);

const isDue = (job: PublicationJob, now: Date): boolean =>
  new Date(job.scheduledAt).getTime() <= now.getTime();

const isStaleProcessingJob = (job: PublicationJob, now: Date): boolean => {
  if (job.status !== "processing" || !job.lockedAt) return false;
  const lockedAt = new Date(job.lockedAt).getTime();
  return Number.isFinite(lockedAt) && now.getTime() - lockedAt >= PUBLICATION_JOB_LOCK_TIMEOUT_MS;
};

export type PublicationWorkerResult = {
  jobId: EntityId;
  contentId: EntityId;
  status: "succeeded" | "failed" | "skipped";
  externalPostId?: string;
  error?: string;
};

export class PublicationWorker {
  constructor(
    private readonly jobs: PublicationJobRepository,
    private readonly jobService: PublicationJobService,
    private readonly executor: PublisherExecutor
  ) {}

  async runOnce(now = new Date()): Promise<PublicationWorkerResult[]> {
    const candidates = (await this.jobs.list())
      .filter((job) => {
        if (!isDue(job, now)) return false;
        if (job.status === "pending") return true;
        if (job.status === "failed") return retryEligibleAt(job) <= now.getTime();
        return isStaleProcessingJob(job, now);
      })
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

    const results: PublicationWorkerResult[] = [];
    for (const candidate of candidates) {
      const claimed = await this.jobService.claim(candidate.id, now);
      if (!claimed) continue;
      results.push(await this.process(claimed, now));
    }
    return results;
  }

  private async process(job: PublicationJob, now: Date): Promise<PublicationWorkerResult> {
    try {
      const result = await this.executor.execute(job.contentId, now, job.idempotencyKey);
      if (result.status === "published" && result.externalPostId) {
        await this.jobService.succeed(job.id, result.externalPostId, now);
        return {
          jobId: job.id,
          contentId: job.contentId,
          status: "succeeded",
          externalPostId: result.externalPostId
        };
      }

      if (result.status === "unsupported") {
        const error = `No publisher adapter supports ${result.content.platform}.`;
        await this.jobService.fail(job.id, error, now);
        return { jobId: job.id, contentId: job.contentId, status: "failed", error };
      }

      const error = `Publication was not completed (status: ${result.status}).`;
      await this.jobService.fail(job.id, error, now);
      return { jobId: job.id, contentId: job.contentId, status: "failed", error };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.jobService.fail(job.id, error, now);
      return { jobId: job.id, contentId: job.contentId, status: "failed", error: message };
    }
  }
}
