import type { Content, EntityId } from "@affiliateos/shared";
import type { PublicationJob, PublicationJobRepository } from "./publication-job.js";
import { createPublicationJob } from "./publication-job.js";

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

  async awaitConfirmation(id: EntityId, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    const next = { ...job, status: "awaiting_confirmation" as const, lockedAt: undefined, lastError: undefined, updatedAt: now.toISOString() };\n    return this.jobs.transition ? (await this.jobs.transition(id, ["processing"], next)) ?? job : this.jobs.save(next);
  }

  async succeed(id: EntityId, externalPostId: string, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    const next = { ...job, status: "succeeded" as const, externalPostId, lockedAt: undefined, lastError: undefined, updatedAt: now.toISOString() };\n    return this.jobs.transition ? (await this.jobs.transition(id, ["processing", "awaiting_confirmation"], next)) ?? job : this.jobs.save(next);
  }

  async fail(id: EntityId, error: unknown, now = new Date()): Promise<PublicationJob> {
    const job = await this.require(id);
    const message = error instanceof Error ? error.message : String(error);
    const next = { ...job, status: "failed" as const, lockedAt: undefined, lastError: message, updatedAt: now.toISOString() };\n    return this.jobs.transition ? (await this.jobs.transition(id, ["processing", "awaiting_confirmation"], next)) ?? job : this.jobs.save(next);
  }

  private async require(id: EntityId) {
    const job = await this.jobs.findById(id);
    if (!job) throw new Error("Publication job does not exist.");
    return job;
  }
}
