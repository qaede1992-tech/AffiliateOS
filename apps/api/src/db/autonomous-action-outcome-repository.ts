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
  ...(row.error ? { error: row.error } : {}),
  ...(row.baselineMetrics ? { baseline: row.baselineMetrics as AutonomousActionOutcome["baseline"] } : {}),
  ...(row.observedMetrics ? { observed: row.observedMetrics as AutonomousActionOutcome["observed"] } : {}),
  ...(row.evaluationMetrics ? { evaluation: row.evaluationMetrics as AutonomousActionOutcome["evaluation"] } : {}),
  ...(row.evaluatedAt ? { evaluatedAt: row.evaluatedAt } : {}),
  ...(row.recoveryState ? { recoveryState: row.recoveryState as AutonomousActionOutcome["recoveryState"] } : {}),
  ...(row.recoveryEvidenceScore !== null && row.recoveryEvidenceScore !== undefined ? { recoveryEvidenceScore: row.recoveryEvidenceScore } : {}),
  ...(row.recoveryEpisodeId ? { recoveryEpisodeId: row.recoveryEpisodeId } : {}),
  ...(row.recoveryPolicy ? { recoveryPolicy: row.recoveryPolicy as AutonomousActionOutcome["recoveryPolicy"] } : {})
});

export class DrizzleAutonomousActionOutcomeRepository implements AutonomousActionOutcomeWriter {
  constructor(private readonly db: DatabaseExecutor) {}

  async save(outcome: AutonomousActionOutcome): Promise<AutonomousActionOutcome> {
    const rows = await this.db.insert(autonomousActionOutcomes).values({
      id: outcome.id,
      campaignId: outcome.campaignId,
      action: outcome.action,
      status: outcome.status,
      mutated: outcome.mutated,
      observedAt: outcome.observedAt,
      error: outcome.error
    }).returning();
    return toDomain(rows[0]);
  }

  async updateMetrics(id: string, metrics: { baseline?: import("../domain/autonomous-action-outcome.js").AutonomousActionMetrics; observed?: import("../domain/autonomous-action-outcome.js").AutonomousActionMetrics }) {
    const rows = await this.db.update(autonomousActionOutcomes).set({
      ...(metrics.baseline ? { baselineMetrics: metrics.baseline } : {}),
      ...(metrics.observed ? { observedMetrics: metrics.observed } : {})
    }).where(eq(autonomousActionOutcomes.id, id)).returning();
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async updateEvaluation(id: string, evaluation: import("../domain/autonomous-action-outcome.js").AutonomousActionMetrics, evaluatedAt: string) {
    const rows = await this.db.update(autonomousActionOutcomes).set({
      evaluationMetrics: evaluation,
      evaluatedAt
    }).where(eq(autonomousActionOutcomes.id, id)).returning();
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async updateRecovery(id: string, recovery: { state: "none" | "recovering" | "recovered"; evidenceScore?: number; episodeId?: string }) {
    const rows = await this.db.update(autonomousActionOutcomes).set({
      recoveryState: recovery.state,
      recoveryEvidenceScore: recovery.evidenceScore ?? 0,
      recoveryEpisodeId: recovery.episodeId
    }).where(eq(autonomousActionOutcomes.id, id)).returning();
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async latestByCampaign(campaignId: string): Promise<AutonomousActionOutcome | undefined> {
    const rows = await this.db.select().from(autonomousActionOutcomes)
      .where(eq(autonomousActionOutcomes.campaignId, campaignId))
      .orderBy(desc(autonomousActionOutcomes.observedAt)).limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }
}
