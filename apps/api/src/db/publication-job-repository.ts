import { and, eq, lte, or, sql } from "drizzle-orm";
import type { PublicationJob } from "../domain/publication-job.js";
import type { PublicationJobRepository } from "../domain/repository.js";
import { publicationJobs } from "./schema.js";

type DatabaseExecutor = any;
type PublicationJobRow = typeof publicationJobs.$inferSelect;

const toPublicationJob = (row: PublicationJobRow): PublicationJob => ({
  id: row.id,
  contentId: row.contentId,
  idempotencyKey: row.idempotencyKey,
  status: row.status as PublicationJob["status"],
  attemptCount: row.attemptCount,
  scheduledAt: row.scheduledAt,
  lockedAt: row.lockedAt ?? undefined,
  externalPostId: row.externalPostId ?? undefined,
  lastError: row.lastError ?? undefined,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

export class DrizzlePublicationJobRepository implements PublicationJobRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async list(): Promise<PublicationJob[]> {
    const rows = await this.db.select().from(publicationJobs);
    return rows.map(toPublicationJob);
  }

  async findById(id: string): Promise<PublicationJob | undefined> {
    const rows = await this.db.select().from(publicationJobs).where(eq(publicationJobs.id, id)).limit(1);
    return rows[0] ? toPublicationJob(rows[0]) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<PublicationJob | undefined> {
    const rows = await this.db.select().from(publicationJobs).where(eq(publicationJobs.idempotencyKey, key)).limit(1);
    return rows[0] ? toPublicationJob(rows[0]) : undefined;
  }

  async save(job: PublicationJob): Promise<PublicationJob> {
    const values = {
      id: job.id,
      contentId: job.contentId,
      idempotencyKey: job.idempotencyKey,
      status: job.status,
      attemptCount: job.attemptCount,
      scheduledAt: job.scheduledAt,
      lockedAt: job.lockedAt ?? null,
      externalPostId: job.externalPostId ?? null,
      lastError: job.lastError ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
    const existing = await this.findById(job.id);
    if (existing) await this.db.update(publicationJobs).set(values).where(eq(publicationJobs.id, job.id));
    else await this.db.insert(publicationJobs).values(values);
    return job;
  }

  async saveIfAbsent(job: PublicationJob): Promise<PublicationJob> {
    const values = {
      id: job.id,
      contentId: job.contentId,
      idempotencyKey: job.idempotencyKey,
      status: job.status,
      attemptCount: job.attemptCount,
      scheduledAt: job.scheduledAt,
      lockedAt: job.lockedAt ?? null,
      externalPostId: job.externalPostId ?? null,
      lastError: job.lastError ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
    const rows = await this.db.insert(publicationJobs)
      .values(values)
      .onConflictDoNothing({ target: publicationJobs.idempotencyKey })
      .returning();
    if (rows[0]) return toPublicationJob(rows[0]);
    const existing = await this.findByIdempotencyKey(job.idempotencyKey);
    if (!existing) throw new Error("Publication job insert was skipped but no idempotent job was found.");
    return existing;
  }

  async claimDue(id: string, now: Date, lockTimeoutMs: number): Promise<PublicationJob | undefined> {
    const nowIso = now.toISOString();
    const staleCutoff = new Date(now.getTime() - lockTimeoutMs).toISOString();
    const rows = await this.db.update(publicationJobs)
      .set({
        status: "processing",
        attemptCount: sql`${publicationJobs.attemptCount} + 1`,
        lockedAt: nowIso,
        updatedAt: nowIso
      })
      .where(and(
        eq(publicationJobs.id, id),
        lte(publicationJobs.scheduledAt, nowIso),
        or(
          eq(publicationJobs.status, "pending"),
          eq(publicationJobs.status, "failed"),
          and(eq(publicationJobs.status, "processing"), lte(publicationJobs.lockedAt, staleCutoff))
        )
      ))
      .returning();
    return rows[0] ? toPublicationJob(rows[0]) : undefined;
  }
}
