import type { Content, EntityId } from "@affiliateos/shared";
import type { PublicationJob, PublicationJobRepository } from "./publication-job.js";
import { createPublicationJob } from "./publication-job.js";

export class PublicationJobService {
  constructor(private readonly jobs: PublicationJobRepository) {}

  async enqueue(content: Content): Promise<PublicationJob> {
    const existing = await this.jobs.findByIdempotencyKey(`content:${content.id}`);
    if (existing) return existing;
    return this.jobs.save(createPublicationJob(content));
  }

  async claim(id: EntityId, now = new Date()): Promise<PublicationJob | undefined> {
    const job = await this.jobs.findById(id);
    if (!job || job.status === "succeeded") return job;
    if (job.status === "processing" && job.lockedAt) {
      const lockAge = now.getTime() - new Date(job.lockedAt).getTime();
      if (Number.isFinite(lockAge) && lockAge < 10 * 60 * 1000) return undefined;
    }
    if (new Date(job.scheduledAt).getTime() > now.getTime()) return undefined;
    const updated = {
      ...job,
      status: "processing" as const,
      attemptCount: job.attemptCount + 1,
      lockedAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    return this.jobs.save(updated);
  }

  async succeed(id: EntityId, externalPostId: string, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    return this.jobs.save({ ...job, status: "succeeded", externalPostId, lockedAt: undefined, lastError: undefined, updatedAt: now.toISOString() });
  }

  async fail(id: EntityId, error: unknown, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    const message = error instanceof Error ? error.message : String(error);
    return this.jobs.save({ ...job, status: "failed", lockedAt: undefined, lastError: message, updatedAt: now.toISOString() });
  }

  private async require(id: EntityId) {
    const job = await this.jobs.findById(id);
    if (!job) throw new Error("Publication job does not exist.");
    return job;
  }
}
