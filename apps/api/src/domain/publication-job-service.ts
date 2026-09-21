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
    const next = { ...job, status: "awaiting_confirmation" as const, lockedAt: undefined, lastError: error, updatedAt: now.toISOString() };
    return this.transitionOrResolve(id, ["pending", "processing", "failed"], next);
  }

  async succeed(id: EntityId, externalPostId: string, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    if (job.status === "succeeded") {
      if (job.externalPostId === externalPostId) return job;
      throw new DomainError("PUBLICATION_JOB_CONFLICT", "The publication job already succeeded with a different external post.", 409);
    }
    const next = { ...job, status: "succeeded" as const, externalPostId, lockedAt: undefined, lastError: undefined, updatedAt: now.toISOString() };
    return this.transitionOrResolve(id, ["pending", "processing", "awaiting_confirmation", "failed"], next);
  }

  async fail(id: EntityId, error: unknown, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    const message = error instanceof Error ? error.message : String(error);
    if (job.status === "succeeded") {
      throw new DomainError("PUBLICATION_JOB_CONFLICT", "A succeeded publication job cannot be failed.", 409);
    }
    if (job.status === "failed" && job.lastError === message) return job;
    const next = { ...job, status: "failed" as const, lockedAt: undefined, lastError: message, updatedAt: now.toISOString() };
    return this.transitionOrResolve(id, ["pending", "processing", "awaiting_confirmation", "failed"], next);
  }

  private async transitionOrResolve(id: EntityId, expected: PublicationJob["status"][], next: PublicationJob): Promise<PublicationJob> {
    if (this.jobs.transition) {
      const transitioned = await this.jobs.transition(id, expected, next);
      if (transitioned) return transitioned;
      const current = await this.require(id);
      if (current.status === next.status) {
        if (next.status === "succeeded" && current.externalPostId === next.externalPostId) return current;
        if (next.status === "failed" && current.lastError === next.lastError) return current;
        if (next.status === "awaiting_confirmation") return current;
      }
      throw new DomainError("PUBLICATION_JOB_CONFLICT", "Publication job state changed before the transition completed.", 409);
    }
    return this.jobs.save(next);
  }

  private async require(id: EntityId): Promise<PublicationJob> {
    const job = await this.jobs.findById(id);
    if (!job) throw new Error("Publication job does not exist.");
    return job;
  }
}
