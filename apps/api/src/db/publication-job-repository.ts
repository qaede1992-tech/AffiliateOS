import { sql } from "drizzle-orm";
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
    const rows = await this.db.select().from(publicationJobs).where(sql`${publicationJobs.id} = ${id}`).limit(1);
    return rows[0] ? toPublicationJob(rows[0]) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<PublicationJob | undefined> {
    const rows = await this.db.select().from(publicationJobs).where(sql`${publicationJobs.idempotencyKey} = ${key}`).limit(1);
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
    if (existing) await this.db.update(publicationJobs).set(values).where(sql`${publicationJobs.id} = ${job.id}`);
    else await this.db.insert(publicationJobs).values(values);
    return job;
  }

  async claimDue(id: string, now: Date, lockTimeoutMs: number): Promise<PublicationJob | undefined> {
    const nowIso = now.toISOString();
    const staleCutoff = new Date(now.getTime() - lockTimeoutMs).toISOString();
    const result = await this.db.execute(sql`
      UPDATE ${publicationJobs}
      SET
        status = 'processing',
        attempt_count = attempt_count + 1,
        locked_at = ${nowIso},
        updated_at = ${nowIso}
      WHERE id = ${id}
        AND scheduled_at <= ${nowIso}
        AND (
          status IN ('pending', 'failed')
          OR (status = 'processing' AND locked_at IS NOT NULL AND locked_at < ${staleCutoff})
        )
      RETURNING *
    `);
    const row = result.rows[0] as PublicationJobRow | undefined;
    return row ? toPublicationJob(row) : undefined;
  }
}
