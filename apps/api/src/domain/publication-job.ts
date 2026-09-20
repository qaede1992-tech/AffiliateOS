import { randomUUID } from "node:crypto";
import type { Content, EntityId, IsoTimestamp } from "@affiliateos/shared";

export type PublicationJobStatus = "pending" | "processing" | "succeeded" | "failed";

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
}

export class InMemoryPublicationJobRepository implements PublicationJobRepository {
  private readonly jobs = new Map<EntityId, PublicationJob>();
  async list() { return [...this.jobs.values()]; }
  async findById(id: EntityId) { return this.jobs.get(id); }
  async findByIdempotencyKey(key: string) { return [...this.jobs.values()].find((job) => job.idempotencyKey === key); }
  async save(job: PublicationJob) { this.jobs.set(job.id, job); return job; }
}

const now = () => new Date().toISOString();

export function createPublicationJob(content: Content): PublicationJob {
  if (content.status !== "scheduled" || !content.scheduledAt) {
    throw new Error("Publication jobs require scheduled content with scheduledAt.");
  }
  const createdAt = now();
  return {
    id: randomUUID(),
    contentId: content.id,
    idempotencyKey: `content:${content.id}`,
    status: "pending",
    attemptCount: 0,
    scheduledAt: content.scheduledAt,
    createdAt,
    updatedAt: createdAt
  };
}
