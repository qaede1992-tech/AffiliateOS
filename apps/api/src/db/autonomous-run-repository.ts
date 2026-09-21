import { and, eq, inArray, lte, or } from "drizzle-orm";
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
  lastError: row.lastError ?? undefined,
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
  lastError: run.lastError ?? null,
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

  async save(run: AutonomousRun): Promise<AutonomousRun> {
    const existing = await this.findById(run.id);
    if (existing) await this.db.update(autonomousRuns).set(toRow(run)).where(eq(autonomousRuns.id, run.id));
    else await this.db.insert(autonomousRuns).values(toRow(run));
    return run;
  }

  async saveIfAbsent(run: AutonomousRun): Promise<AutonomousRun> {
    const rows = await this.db.insert(autonomousRuns)
      .values(toRow(run))
      .onConflictDoNothing({ target: autonomousRuns.idempotencyKey })
      .returning();
    if (rows[0]) return toDomain(rows[0]);
    const existing = await this.findByIdempotencyKey(run.idempotencyKey);
    if (!existing) throw new Error("Autonomous run insert was skipped but no idempotent run was found.");
    return existing;
  }

  async transition(id: string, expected: AutonomousRunStatus[], run: AutonomousRun): Promise<AutonomousRun | undefined> {
    const rows = await this.db.update(autonomousRuns)
      .set(toRow(run))
      .where(and(eq(autonomousRuns.id, id), inArray(autonomousRuns.status, expected)))
      .returning();
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async listRecoverable(staleBefore: Date, limit = 100): Promise<AutonomousRun[]> {
    const rows = await this.db.select().from(autonomousRuns).where(or(
      inArray(autonomousRuns.status, ["accepted", "failed"]),
      and(eq(autonomousRuns.status, "processing"), lte(autonomousRuns.updatedAt, staleBefore.toISOString()))
    )).orderBy(autonomousRuns.updatedAt).limit(Math.max(1, limit));
    return rows.map(toDomain);
  }

  async claimProcessing(id: string, now: Date, staleAfterMs: number): Promise<AutonomousRun | undefined> {
    const staleCutoff = new Date(now.getTime() - staleAfterMs).toISOString();
    const rows = await this.db.update(autonomousRuns)
      .set({ status: "processing", lastError: null, updatedAt: now.toISOString() })
      .where(and(
        eq(autonomousRuns.id, id),
        or(
          inArray(autonomousRuns.status, ["accepted", "failed"]),
          and(eq(autonomousRuns.status, "processing"), lte(autonomousRuns.updatedAt, staleCutoff))
        )
      ))
      .returning();
    return rows[0] ? toDomain(rows[0]) : undefined;
  }
}
