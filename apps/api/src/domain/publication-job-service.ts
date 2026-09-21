import type { Content, EntityId } from "@affiliateos/shared";
import type { PublicationJob, PublicationJobRepository } from "./publication-job.js";
import { createPublicationJob } from "./publication-job.js";
import { DomainError } from "./errors.js";

const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

export class PublicationJobService {
  constructor(private readonly jobs: PublicationJobRepository) {}

  async enqueue(content: Content): Promise<PublicationJob> {
    const job = createPublicationJob(content);
    if (this.jobs.saveIfAbsent) return this.jobs.saveIfAbsent(job);
    const existing = await this.jobs.findByIdempotencyKey(job.idempotencyKey);
    if (existing) return existing;
    return this.jobs.save(job);
  }

  async claim(id: EntityId, now = new Date()): Promise<PublicationJob | undefined> {
    if (this.jobs.claimDue) return this.jobs.claimDue(id, now, LOCK_TIMEOUT_MS);
    const job = await this.jobs.findById(id);
    if (!job || job.status === "succeeded" || job.status === "awaiting_confirmation") return undefined;
    if (job.status === "processing" && job.lockedAt) {
      const lockAge = now.getTime() - new Date(job.lockedAt).getTime();
      if (Number.isFinite(lockAge) && lockAge < LOCK_TIMEOUT_MS) return undefined;
    }
    if (new Date(job.scheduledAt).getTime() > now.getTime()) return undefined;
    return this.jobs.save({
      ...job,
      status: "processing",
      attemptCount: job.attemptCount + 1,
      lockedAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
  }

  async awaitConfirmation(id: EntityId, now = new Date(), error?: string): Promise<PublicationJob> {
    const job = await this.require(id);
    if (job.status === "awaiting_confirmation") return job;
    if (job.status === "succeeded") {
      throw new DomainError("PUBLICATION_JOB_CONFLICT", "A succeeded publication job cannot await confirmation.", 409);
    }
    return this.jobs.save({ ...job, status: "awaiting_confirmation", lockedAt: undefined, lastError: error, updatedAt: now.toISOString() });
  }

  async succeed(id: EntityId, externalPostId: string, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    if (job.status === "succeeded") {
      if (job.externalPostId === externalPostId) return job;
      throw new DomainError("PUBLICATION_JOB_CONFLICT", "The publication job already succeeded with a different external post.", 409);
    }
    return this.jobs.save({ ...job, status: "succeeded", externalPostId, lockedAt: undefined, lastError: undefined, updatedAt: now.toISOString() });
  }

  async fail(id: EntityId, error: unknown, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    const message = error instanceof Error ? error.message : String(error);
    if (job.status === "succeeded") {
      throw new DomainError("PUBLICATION_JOB_CONFLICT", "A succeeded publication job cannot be failed.", 409);
    }
    if (job.status === "failed" && job.lastError === message) return job;
    return this.jobs.save({ ...job, status: "failed", lockedAt: undefined, lastError: message, updatedAt: now.toISOString() });
  }

  private async require(id: EntityId): Promise<PublicationJob> {
    const job = await this.jobs.findById(id);
    if (!job) throw new Error("Publication job does not exist.");
    return job;
  }
}
