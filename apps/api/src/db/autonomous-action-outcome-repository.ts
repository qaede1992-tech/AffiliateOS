import { desc, eq } from "drizzle-orm";
import type { AutonomousActionOutcome, AutonomousActionOutcomeWriter } from "../domain/autonomous-action-outcome.js";
import { autonomousActionOutcomes } from "./schema.js";

type DatabaseExecutor = any;
type OutcomeRow = typeof autonomousActionOutcomes.$inferSelect;

const toDomain = (row: OutcomeRow): AutonomousActionOutcome => ({
  id: row.id,
  campaignId: row.campaignId,
  action: row.action as AutonomousActionOutcome["action"],
  status: row.status as AutonomousActionOutcome["status"],
  mutated: row.mutated,
  observedAt: row.observedAt,
  ...(row.error ? { error: row.error } : {})
});

export class DrizzleAutonomousActionOutcomeRepository implements AutonomousActionOutcomeWriter {
  constructor(private readonly db: DatabaseExecutor) {}
  async save(outcome: AutonomousActionOutcome): Promise<AutonomousActionOutcome> {
    const rows = await this.db.insert(autonomousActionOutcomes).values({
      id: outcome.id, campaignId: outcome.campaignId, action: outcome.action,
      status: outcome.status, mutated: outcome.mutated, observedAt: outcome.observedAt, error: outcome.error
    }).returning();
    return toDomain(rows[0]);
  }
  async latestByCampaign(campaignId: string): Promise<AutonomousActionOutcome | undefined> {
    const rows = await this.db.select().from(autonomousActionOutcomes)
      .where(eq(autonomousActionOutcomes.campaignId, campaignId))
      .orderBy(desc(autonomousActionOutcomes.observedAt)).limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }
}
