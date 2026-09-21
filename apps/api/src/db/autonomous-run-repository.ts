import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { AutonomousRun, AutonomousRunRepository, AutonomousRunStatus } from "../domain/autonomous-run.js";
import { autonomousRuns } from "./schema.js";

type DatabaseExecutor = any;
type AutonomousRunRow = typeof autonomousRuns.$inferSelect;

const toDomain = (row: AutonomousRunRow): AutonomousRun => ({
  id: row.id,
  idempotencyKey: row.idempotencyKey,
  opportunityProductId: row.opportunityProductId,
  offerId: row.offerId,
  campaignId: row.campaignId ?? undefined,
  status: row.status as AutonomousRunStatus,
  attemptCount: row.attemptCount,
  nextAttemptAt: row.nextAttemptAt ?? undefined,
  lastError: row.lastError ?? undefined,
  executionContext: row.executionContext as AutonomousRun["executionContext"],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

const toRow = (run: AutonomousRun) => ({
  id: run.id,
  idempotencyKey: run.idempotencyKey,
  opportunityProductId: run.opportunityProductId,
  offerId: run.offerId,
  campaignId: run.campaignId ?? null,
  status: run.status,
  attemptCount: run.attemptCount,
  nextAttemptAt: run.nextAttemptAt ?? null,
  lastError: run.lastError ?? null,
  executionContext: run.executionContext ?? {},
  createdAt: run.createdAt,
  updatedAt: run.updatedAt
});

export class DrizzleAutonomousRunRepository implements AutonomousRunRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async findByIdempotencyKey(key: string): Promise<AutonomousRun | undefined> {
    const rows = await this.db.select().from(autonomousRuns).where(eq(autonomousRuns.idempotencyKey, key)).limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async findById(id: string): Promise<AutonomousRun | undefined> {
    const rows = await this.db.select().from(autonomousRuns).where(eq(autonomousRuns.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async list(options: { status?: AutonomousRunStatus; limit?: number } = {}): Promise<AutonomousRun[]> {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 100);
    const whereClause = options.status ? eq(autonomousRuns.status, options.status) : undefined;
    const rows = await this.db.select().from(autonomousRuns)
      .where(whereClause)
      .orderBy(desc(autonomousRuns.updatedAt))
      .limit(limit);
    return rows.map(toDomain);
  }

  async save(run: AutonomousRun): Promise<AutonomousRun> {
    const existing = await this.findById(run.id);
    if (existing) await this.db.update(autonomousRuns).set(toRow(run)).where(eq(autonomousRuns.id, run.id));
    else await this.db.insert(autonomousRuns).values(toRow(run));
    return run;
  }

  async saveIfAbsent(run: AutonomousRun): Promise<AutonomousRun> {
    const rows = await this.db.insert(autonomousRuns).values(toRow(run))
      .onConflictDoNothing({ target: autonomousRuns.idempotencyKey }).returning();
    if (rows[0]) return toDomain(rows[0]);
    const existing = await this.findByIdempotencyKey(run.idempotencyKey);
    if (!existing) throw new Error("Autonomous run insert was skipped but no idempotent run was found.");
    return existing;
  }

  async transition(id: string, expected: AutonomousRunStatus[], run: AutonomousRun): Promise<AutonomousRun | undefined> {
    const rows = await this.db.update(autonomousRuns).set({
      status: run.status,
      campaignId: run.campaignId ?? null,
      attemptCount: run.attemptCount,
      nextAttemptAt: run.nextAttemptAt ?? null,
      lastError: run.lastError ?? null,
      updatedAt: run.updatedAt
    }).where(and(eq(autonomousRuns.id, id), inArray(autonomousRuns.status, expected))).returning();
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async listRecoverable(staleBefore: Date, now = new Date(), limit = 100, maxAttempts = 8): Promise<AutonomousRun[]> {
    const rows = await this.db.select().from(autonomousRuns).where(and(
      lte(autonomousRuns.attemptCount, maxAttempts - 1),
      or(
        eq(autonomousRuns.status, "accepted"),
        and(eq(autonomousRuns.status, "failed"), or(isNull(autonomousRuns.nextAttemptAt), lte(autonomousRuns.nextAttemptAt, now.toISOString()))),
        and(eq(autonomousRuns.status, "processing"), lte(autonomousRuns.updatedAt, staleBefore.toISOString()))
      )
    )).orderBy(autonomousRuns.updatedAt).limit(Math.max(1, limit));
    return rows.map(toDomain);
  }

  async claimProcessing(id: string, now: Date, staleAfterMs: number, maxAttempts = 8): Promise<AutonomousRun | undefined> {
    const staleCutoff = new Date(now.getTime() - staleAfterMs).toISOString();
    const nowIso = now.toISOString();
    const rows = await this.db.update(autonomousRuns).set({
      status: "processing",
      attemptCount: sql`attempt_count + 1`,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: nowIso
    }).where(and(
      eq(autonomousRuns.id, id),
      lte(autonomousRuns.attemptCount, maxAttempts - 1),
      or(
        eq(autonomousRuns.status, "accepted"),
        and(eq(autonomousRuns.status, "failed"), or(isNull(autonomousRuns.nextAttemptAt), lte(autonomousRuns.nextAttemptAt, nowIso))),
        and(eq(autonomousRuns.status, "processing"), lte(autonomousRuns.updatedAt, staleCutoff))
      )
    )).returning();
    return rows[0] ? toDomain(rows[0]) : undefined;
  }
}
