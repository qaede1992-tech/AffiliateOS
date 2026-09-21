import { randomUUID } from "node:crypto";
import type { Content, EntityId, IsoTimestamp } from "@affiliateos/shared";

export type PublicationJobStatus = "pending" | "processing" | "awaiting_confirmation" | "succeeded" | "failed";

export interface PublicationJob {
  id: EntityId;
  contentId: EntityId;
  idempotencyKey: string;
  status: PublicationJobStatus;
  attemptCount: number;
  scheduledAt: IsoTimestamp;
  lockedAt?: IsoTimestamp;
  externalPostId?: string;
  lastError?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface PublicationJobRepository {
  list(): Promise<PublicationJob[]>;
  findById(id: EntityId): Promise<PublicationJob | undefined>;
  findByIdempotencyKey(key: string): Promise<PublicationJob | undefined>;
  save(job: PublicationJob): Promise<PublicationJob>;
  claimDue?(id: EntityId, now: Date, lockTimeoutMs: number): Promise<PublicationJob | undefined>;
  saveIfAbsent?(job: PublicationJob): Promise<PublicationJob>;
  transition?(id: EntityId, expected: PublicationJobStatus[], job: PublicationJob): Promise<PublicationJob | undefined>;
}

export class InMemoryPublicationJobRepository implements PublicationJobRepository {
  private readonly jobs = new Map<EntityId, PublicationJob>();
  async list() { return [...this.jobs.values()]; }
  async findById(id: EntityId) { return this.jobs.get(id); }
  async findByIdempotencyKey(key: string) { return [...this.jobs.values()].find((job) => job.idempotencyKey === key); }
  async save(job: PublicationJob) { this.jobs.set(job.id, job); return job; }
  async saveIfAbsent(job: PublicationJob) {
    const existing = [...this.jobs.values()].find((candidate) => candidate.idempotencyKey === job.idempotencyKey);
    if (existing) return existing;
    this.jobs.set(job.id, job);
    return job;
  }

  async transition(id: EntityId, expected: PublicationJobStatus[], job: PublicationJob) {
    const current = this.jobs.get(id);
    if (!current || !expected.includes(current.status)) return undefined;
    const next: PublicationJob = {
      ...current,
      status: job.status,
      attemptCount: job.attemptCount,
      scheduledAt: job.scheduledAt,
      lockedAt: job.lockedAt,
      externalPostId: job.externalPostId,
      lastError: job.lastError,
      updatedAt: job.updatedAt
    };
    this.jobs.set(id, next);
    return next;
  }

  async claimDue(id: EntityId, nowDate: Date, lockTimeoutMs: number) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const scheduled = new Date(job.scheduledAt).getTime();
    const locked = job.lockedAt ? new Date(job.lockedAt).getTime() : undefined;
    const lockFresh = locked !== undefined && nowDate.getTime() - locked < lockTimeoutMs;
    const claimableStatus = job.status === "pending" || job.status === "failed" ||
      (job.status === "processing" && !lockFresh);
    if (!claimableStatus || scheduled > nowDate.getTime() || lockFresh) return undefined;
    const claimed: PublicationJob = { ...job, status: "processing", attemptCount: job.attemptCount + 1, lockedAt: nowDate.toISOString(), updatedAt: nowDate.toISOString() };
    this.jobs.set(id, claimed);
    return claimed;
  }
}

const now = () => new Date().toISOString();

export function createPublicationJob(content: Content): PublicationJob {
  if (content.status !== "scheduled" || !content.scheduledAt) throw new Error("Publication jobs require scheduled content with scheduledAt.");
  const createdAt = now();
  return { id: randomUUID(), contentId: content.id, idempotencyKey: `content:${content.id}`, status: "pending", attemptCount: 0, scheduledAt: content.scheduledAt, createdAt, updatedAt: createdAt };
}
