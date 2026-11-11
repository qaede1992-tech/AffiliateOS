import { desc, eq, and, gte, sql } from "drizzle-orm";
import type { AutonomousFeedbackMemoryRepository, AutonomousFeedbackSnapshot } from "../domain/autonomous-feedback-memory.js";
import { autonomousFeedbackSnapshots } from "./schema.js";

type DatabaseExecutor = any;
type SnapshotRow = typeof autonomousFeedbackSnapshots.$inferSelect & {
  recoveryQualityScore: number;
  recoveryPolicy: AutonomousFeedbackSnapshot["recoveryPolicy"] | null;
};

const feedbackSnapshotsTable = autonomousFeedbackSnapshots as any;

const toDomain = (row: SnapshotRow): AutonomousFeedbackSnapshot => ({
  id: row.id,
  observationKey: row.observationKey,
  productId: row.productId,
  marketplaceId: row.marketplaceId,
  clickCount: row.clickCount,
  conversionCount: row.conversionCount,
  attributedCommissionCents: row.attributedCommissionCents,
  commissionPerClickCents: row.commissionPerClickCents,
  conversionRate: row.conversionRate,
  adjustment: row.adjustment,
  anomaly: (row.anomaly ?? "none") as "none" | "watch" | "halt",
  anomalyScore: row.anomalyScore ?? 0,
  recoveryState: (row.recoveryState ?? "none") as "none" | "recovering" | "recovered",
  recoveryClicks: row.recoveryClicks ?? 0,
  recoveryEvidenceScore: row.recoveryEvidenceScore ?? 0,
  recoveryQualityScore: row.recoveryQualityScore ?? 0,
  recoveryPolicy: row.recoveryPolicy ?? undefined,
  recoveryEpisodeId: row.recoveryEpisodeId ?? undefined,
  observedAt: row.observedAt
});

export class DrizzleAutonomousFeedbackMemoryRepository implements AutonomousFeedbackMemoryRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async save(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot> {
    await this.db.insert(feedbackSnapshotsTable).values({
      id: snapshot.id,
      observationKey: snapshot.observationKey,
      productId: snapshot.productId,
      marketplaceId: snapshot.marketplaceId,
      clickCount: snapshot.clickCount,
      conversionCount: snapshot.conversionCount,
      attributedCommissionCents: snapshot.attributedCommissionCents,
      commissionPerClickCents: snapshot.commissionPerClickCents,
      conversionRate: snapshot.conversionRate,
      adjustment: snapshot.adjustment,
      anomaly: snapshot.anomaly,
      anomalyScore: snapshot.anomalyScore,
      recoveryState: snapshot.recoveryState,
      recoveryClicks: snapshot.recoveryClicks,
      recoveryEvidenceScore: snapshot.recoveryEvidenceScore,
      recoveryQualityScore: snapshot.recoveryQualityScore,
      recoveryPolicy: snapshot.recoveryPolicy,
      recoveryEpisodeId: snapshot.recoveryEpisodeId,
      observedAt: snapshot.observedAt
    });
    return snapshot;
  }

  async saveIfAbsent(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot> {
    const rows = await this.db.insert(feedbackSnapshotsTable)
      .values({
        id: snapshot.id,
        observationKey: snapshot.observationKey,
        productId: snapshot.productId,
        marketplaceId: snapshot.marketplaceId,
        clickCount: snapshot.clickCount,
        conversionCount: snapshot.conversionCount,
        attributedCommissionCents: snapshot.attributedCommissionCents,
        commissionPerClickCents: snapshot.commissionPerClickCents,
        conversionRate: snapshot.conversionRate,
        adjustment: snapshot.adjustment,
        anomaly: snapshot.anomaly,
        anomalyScore: snapshot.anomalyScore,
        recoveryState: snapshot.recoveryState,
        recoveryClicks: snapshot.recoveryClicks,
        recoveryEvidenceScore: snapshot.recoveryEvidenceScore,
        recoveryQualityScore: snapshot.recoveryQualityScore,
        recoveryPolicy: snapshot.recoveryPolicy,
        recoveryEpisodeId: snapshot.recoveryEpisodeId,
        observedAt: snapshot.observedAt
      })
      .onConflictDoNothing({ target: feedbackSnapshotsTable.observationKey })
      .returning();
    if (rows[0]) return toDomain(rows[0] as SnapshotRow);
    const existing = await this.latestByObservationKey(snapshot.observationKey);
    if (!existing) throw new Error("Autonomous feedback snapshot insert was skipped but no observation was found.");
    return existing;
  }

  private async latestByObservationKey(observationKey: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    const rows = await this.db.select().from(feedbackSnapshotsTable)
      .where(eq(autonomousFeedbackSnapshots.observationKey, observationKey))
      .limit(1);
    return rows[0] ? toDomain(rows[0] as SnapshotRow) : undefined;
  }

  async latestByProduct(productId: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    const rows = await this.db.select().from(feedbackSnapshotsTable)
      .where(eq(autonomousFeedbackSnapshots.productId, productId))
      .orderBy(desc(autonomousFeedbackSnapshots.observedAt), desc(autonomousFeedbackSnapshots.id))
      .limit(1);
    return rows[0] ? toDomain(rows[0] as SnapshotRow) : undefined;
  }

  async recentByProductAndMarketplace(productId: string, marketplaceId: string, since: string): Promise<AutonomousFeedbackSnapshot[]> {
    const rows = await this.db.select().from(feedbackSnapshotsTable)
      .where(and(eq(autonomousFeedbackSnapshots.productId, productId), eq(autonomousFeedbackSnapshots.marketplaceId, marketplaceId), gte(autonomousFeedbackSnapshots.observedAt, since)))
      .orderBy(autonomousFeedbackSnapshots.observedAt, autonomousFeedbackSnapshots.id);
    return rows.map((row: SnapshotRow) => toDomain(row));
  }

  async feedbackEvaluationHistory(productId: string, marketplaceId: string, since: string): Promise<AutonomousFeedbackSnapshot[]> {
    const sinceMs = Date.parse(since);
    if (!Number.isFinite(sinceMs)) throw new Error("Feedback history cutoff must be a valid timestamp.");
    const since7d = new Date(sinceMs + 23 * 24 * 60 * 60_000).toISOString();
    const since24h = new Date(sinceMs + 29 * 24 * 60 * 60_000).toISOString();
    const result = await this.db.execute(sql`
      WITH history AS (
        SELECT
          id,
          observation_key AS "observationKey",
          product_id AS "productId",
          marketplace_id AS "marketplaceId",
          click_count AS "clickCount",
          conversion_count AS "conversionCount",
          attributed_commission_cents AS "attributedCommissionCents",
          commission_per_click_cents AS "commissionPerClickCents",
          conversion_rate AS "conversionRate",
          adjustment,
          anomaly,
          anomaly_score AS "anomalyScore",
          recovery_state AS "recoveryState",
          recovery_clicks AS "recoveryClicks",
          recovery_evidence_score AS "recoveryEvidenceScore",
          recovery_quality_score AS "recoveryQualityScore",
          recovery_policy AS "recoveryPolicy",
          recovery_episode_id AS "recoveryEpisodeId",
          observed_at AS "observedAt"
        FROM public.autonomous_feedback_snapshots
        WHERE product_id = ${productId}
          AND marketplace_id = ${marketplaceId}
          AND observed_at >= ${since}
      ),
      last_halt AS (
        SELECT id, "observedAt"
        FROM history
        WHERE anomaly = 'halt'
        ORDER BY "observedAt" DESC, id DESC
        LIMIT 1
      ),
      selected AS (
        (SELECT * FROM history ORDER BY "observedAt" ASC, id ASC LIMIT 1)
        UNION ALL
        (SELECT * FROM history WHERE "observedAt" >= ${since7d} ORDER BY "observedAt" ASC, id ASC LIMIT 1)
        UNION ALL
        (SELECT * FROM history WHERE "observedAt" >= ${since24h} ORDER BY "observedAt" ASC, id ASC LIMIT 1)
        UNION ALL
        (SELECT * FROM history ORDER BY "observedAt" DESC, id DESC LIMIT 1)
        UNION ALL
        (SELECT * FROM history WHERE anomaly = 'halt' ORDER BY "observedAt" DESC, id DESC LIMIT 1)
        UNION ALL
        (
          SELECT h.*
          FROM history h
          JOIN last_halt l ON h."recoveryEpisodeId" = l.id AND h."recoveryState" = 'recovered'
          ORDER BY h."observedAt" ASC, h.id ASC
          LIMIT 1
        )
        UNION ALL
        (
          SELECT h.*
          FROM history h
          CROSS JOIN last_halt l
          WHERE (h."observedAt", h.id) > (l."observedAt", l.id)
          ORDER BY h."observedAt" DESC, h.id DESC
          LIMIT 3
        )
      )
      SELECT DISTINCT *
      FROM selected
      ORDER BY "observedAt" ASC, id ASC
    `);
    return result.rows.map((row: SnapshotRow) => toDomain(row));
  }

  async recoveryEpisodeAnalytics(productId: string, marketplaceId: string, episodeId: string): Promise<import("../domain/autonomous-feedback-memory.js").RecoveryEpisodeAnalytics | undefined> {
    const snapshots = await this.recentByProductAndMarketplace(productId, marketplaceId, new Date(Date.now()-30*24*60*60*1000).toISOString());
    const episode = snapshots.filter(s=>s.recoveryEpisodeId===episodeId);
    const start=episode[0];
    if(!start) return undefined;
    const end=episode.find(s=>s.recoveryState==="recovered");
    const last=end??episode.at(-1)!;
    return {episodeId,startedAt:start.observedAt,endedAt:end?.observedAt,durationMs:end?Math.max(0,Date.parse(end.observedAt)-Date.parse(start.observedAt)):undefined,snapshotCount:episode.length,recoveryClicks:last.recoveryClicks,conversionDelta:last.conversionCount-start.conversionCount,commissionDeltaCents:last.attributedCommissionCents-start.attributedCommissionCents,averageQualityScore:episode.reduce((sum,s)=>sum+s.recoveryQualityScore,0)/episode.length,closingQualityScore:end?.recoveryQualityScore,closed:Boolean(end)};
  }

  async latestByProductAndMarketplace(productId: string, marketplaceId: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    const rows = await this.db.select().from(feedbackSnapshotsTable)
      .where(and(eq(autonomousFeedbackSnapshots.productId, productId), eq(autonomousFeedbackSnapshots.marketplaceId, marketplaceId)))
      .orderBy(desc(autonomousFeedbackSnapshots.observedAt), desc(autonomousFeedbackSnapshots.id))
      .limit(1);
    return rows[0] ? toDomain(rows[0] as SnapshotRow) : undefined;
  }
}
