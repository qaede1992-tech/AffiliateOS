import { desc, eq, and, gte, sql } from "drizzle-orm";
import type { AutonomousFeedbackMemoryRepository, AutonomousFeedbackSnapshot } from "../domain/autonomous-feedback-memory.js";
import { autonomousFeedbackSnapshots } from "./schema.js";

type DatabaseExecutor = any;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}
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

  async relevantByProductAndMarketplace(
    productId: string,
    marketplaceId: string,
    since: string,
    observedAt: string
  ): Promise<AutonomousFeedbackSnapshot[]> {
    const observedMs = Date.parse(observedAt);
    const boundary24h = new Date(observedMs - 24 * 60 * 60 * 1000).toISOString();
    const boundary7d = new Date(observedMs - 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.db.execute(sql`
      WITH latest_halt AS (
        SELECT id, observed_at
        FROM autonomous_feedback_snapshots
        WHERE product_id = ${productId}::uuid
          AND marketplace_id = ${marketplaceId}::uuid
          AND observed_at >= ${since}
          AND observed_at <= ${observedAt}
          AND anomaly = 'halt'
        ORDER BY observed_at DESC, id DESC
        LIMIT 1
      ), selected AS (
        (SELECT id, observation_key, product_id, marketplace_id, click_count, conversion_count,
                attributed_commission_cents, commission_per_click_cents, conversion_rate, adjustment,
                anomaly, anomaly_score, recovery_state, recovery_clicks, recovery_evidence_score,
                recovery_quality_score, recovery_episode_id, observed_at
         FROM autonomous_feedback_snapshots
         WHERE product_id = ${productId}::uuid AND marketplace_id = ${marketplaceId}::uuid
           AND observed_at >= ${boundary24h} AND observed_at <= ${observedAt}
         ORDER BY observed_at, id LIMIT 1)
        UNION ALL
        (SELECT id, observation_key, product_id, marketplace_id, click_count, conversion_count,
                attributed_commission_cents, commission_per_click_cents, conversion_rate, adjustment,
                anomaly, anomaly_score, recovery_state, recovery_clicks, recovery_evidence_score,
                recovery_quality_score, recovery_episode_id, observed_at
         FROM autonomous_feedback_snapshots
         WHERE product_id = ${productId}::uuid AND marketplace_id = ${marketplaceId}::uuid
           AND observed_at >= ${boundary7d} AND observed_at <= ${observedAt}
         ORDER BY observed_at, id LIMIT 1)
        UNION ALL
        (SELECT id, observation_key, product_id, marketplace_id, click_count, conversion_count,
                attributed_commission_cents, commission_per_click_cents, conversion_rate, adjustment,
                anomaly, anomaly_score, recovery_state, recovery_clicks, recovery_evidence_score,
                recovery_quality_score, recovery_episode_id, observed_at
         FROM autonomous_feedback_snapshots
         WHERE product_id = ${productId}::uuid AND marketplace_id = ${marketplaceId}::uuid
           AND observed_at >= ${since} AND observed_at <= ${observedAt}
         ORDER BY observed_at, id LIMIT 1)
        UNION ALL
        (SELECT id, observation_key, product_id, marketplace_id, click_count, conversion_count,
                attributed_commission_cents, commission_per_click_cents, conversion_rate, adjustment,
                anomaly, anomaly_score, recovery_state, recovery_clicks, recovery_evidence_score,
                recovery_quality_score, recovery_episode_id, observed_at
         FROM autonomous_feedback_snapshots
         WHERE product_id = ${productId}::uuid AND marketplace_id = ${marketplaceId}::uuid
           AND observed_at >= ${since} AND observed_at <= ${observedAt}
         ORDER BY observed_at DESC, id DESC LIMIT 1)
        UNION ALL
        (SELECT s.id, s.observation_key, s.product_id, s.marketplace_id, s.click_count, s.conversion_count,
                s.attributed_commission_cents, s.commission_per_click_cents, s.conversion_rate, s.adjustment,
                s.anomaly, s.anomaly_score, s.recovery_state, s.recovery_clicks, s.recovery_evidence_score,
                s.recovery_quality_score, s.recovery_episode_id, s.observed_at
         FROM autonomous_feedback_snapshots s CROSS JOIN latest_halt h
         WHERE s.product_id = ${productId}::uuid AND s.marketplace_id = ${marketplaceId}::uuid
           AND s.observed_at > h.observed_at AND s.observed_at <= ${observedAt}
         ORDER BY s.observed_at DESC, s.id DESC LIMIT 3)
        UNION ALL
        (SELECT s.id, s.observation_key, s.product_id, s.marketplace_id, s.click_count, s.conversion_count,
                s.attributed_commission_cents, s.commission_per_click_cents, s.conversion_rate, s.adjustment,
                s.anomaly, s.anomaly_score, s.recovery_state, s.recovery_clicks, s.recovery_evidence_score,
                s.recovery_quality_score, s.recovery_episode_id, s.observed_at
         FROM autonomous_feedback_snapshots s JOIN latest_halt h
           ON s.recovery_episode_id = h.id AND s.recovery_state = 'recovered'
         WHERE s.product_id = ${productId}::uuid AND s.marketplace_id = ${marketplaceId}::uuid
           AND s.observed_at > h.observed_at AND s.observed_at <= ${observedAt}
         ORDER BY s.observed_at, s.id LIMIT 1)
      )
      SELECT DISTINCT ON (id)
        id, observation_key AS "observationKey", product_id AS "productId",
        marketplace_id AS "marketplaceId", click_count AS "clickCount",
        conversion_count AS "conversionCount", attributed_commission_cents AS "attributedCommissionCents",
        commission_per_click_cents AS "commissionPerClickCents", conversion_rate AS "conversionRate",
        adjustment, anomaly, anomaly_score AS "anomalyScore", recovery_state AS "recoveryState",
        recovery_clicks AS "recoveryClicks", recovery_evidence_score AS "recoveryEvidenceScore",
        recovery_quality_score AS "recoveryQualityScore", recovery_episode_id AS "recoveryEpisodeId",
        observed_at AS "observedAt"
      FROM selected
      ORDER BY id, observed_at DESC
    `);
    return rowsOf(result).map((row) => toDomain({
      ...row,
      clickCount: Number(row.clickCount),
      conversionCount: Number(row.conversionCount),
      attributedCommissionCents: Number(row.attributedCommissionCents),
      commissionPerClickCents: Number(row.commissionPerClickCents),
      conversionRate: Number(row.conversionRate),
      adjustment: Number(row.adjustment),
      anomalyScore: Number(row.anomalyScore),
      recoveryClicks: Number(row.recoveryClicks),
      recoveryEvidenceScore: Number(row.recoveryEvidenceScore),
      recoveryQualityScore: Number(row.recoveryQualityScore)
    } as SnapshotRow)).sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id));
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
