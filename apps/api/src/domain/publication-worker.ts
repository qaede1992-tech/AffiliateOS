import type { EntityId } from "@affiliateos/shared";
import { PublisherExecutor } from "./publisher-executor.js";
import type { PublicationJob } from "./publication-job.js";
import { PublicationJobService } from "./publication-job-service.js";
import type { PublicationJobRepository } from "./publication-job.js";

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
      .filter((job) => job.status === "pending" || job.status === "failed")
      .filter((job) => new Date(job.scheduledAt).getTime() <= now.getTime())
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
      const result = await this.executor.execute(job.contentId, now);
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
