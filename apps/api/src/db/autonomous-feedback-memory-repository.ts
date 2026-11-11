import { desc, eq, and, sql } from "drizzle-orm";
import type { AutonomousFeedbackMemoryRepository, AutonomousFeedbackSnapshot } from "../domain/autonomous-feedback-memory.js";
import { autonomousFeedbackSnapshots } from "./schema.js";

type DatabaseExecutor = any;
type SnapshotRow = typeof autonomousFeedbackSnapshots.$inferSelect & {
  recoveryQualityScore: number;
  recoveryPolicy: AutonomousFeedbackSnapshot["recoveryPolicy"] | null;
};

const feedbackSnapshotsTable = autonomousFeedbackSnapshots as any;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

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
    // The feedback provider only needs the first observation at each window cutoff,
    // the latest observation, and (during an active recovery) the halt anchor plus
    // the last three post-halt observations. Returning the entire 30-day history
    // repeatedly caused thousands of redundant rows to cross the database boundary.
    const sinceMillis = Date.parse(since);
    if (!Number.isFinite(sinceMillis)) throw new Error("Feedback history cutoff must be a valid timestamp.");
    const since7d = new Date(sinceMillis + 23 * 24 * 60 * 60_000).toISOString();
    const since24h = new Date(sinceMillis + 29 * 24 * 60 * 60_000).toISOString();
    const result = await this.db.execute(sql`
      WITH latest AS MATERIALIZED (
        SELECT *
        FROM autonomous_feedback_snapshots
        WHERE product_id = ${productId}::uuid
          AND marketplace_id = ${marketplaceId}::uuid
        ORDER BY observed_at DESC, id DESC
        LIMIT 1
      ),
      halt_anchor AS MATERIALIZED (
        SELECT halt.*
        FROM autonomous_feedback_snapshots halt
        CROSS JOIN latest current_snapshot
        WHERE halt.id = CASE
          WHEN current_snapshot.anomaly = 'halt' THEN current_snapshot.id
          WHEN current_snapshot.recovery_state = 'recovering' THEN current_snapshot.recovery_episode_id
          ELSE NULL
        END
      ),
      anchors AS (
        (
          SELECT * FROM autonomous_feedback_snapshots
          WHERE product_id = ${productId}::uuid
            AND marketplace_id = ${marketplaceId}::uuid
            AND observed_at >= ${since24h}::timestamptz
          ORDER BY observed_at, id
          LIMIT 1
        )
        UNION
        (
          SELECT * FROM autonomous_feedback_snapshots
          WHERE product_id = ${productId}::uuid
            AND marketplace_id = ${marketplaceId}::uuid
            AND observed_at >= ${since7d}::timestamptz
          ORDER BY observed_at, id
          LIMIT 1
        )
        UNION
        (
          SELECT * FROM autonomous_feedback_snapshots
          WHERE product_id = ${productId}::uuid
            AND marketplace_id = ${marketplaceId}::uuid
            AND observed_at >= ${since}::timestamptz
          ORDER BY observed_at, id
          LIMIT 1
        )
        UNION
        (SELECT * FROM latest)
        UNION
        (
          SELECT recent.*
          FROM halt_anchor
          CROSS JOIN LATERAL (
            SELECT snapshot.*
            FROM autonomous_feedback_snapshots snapshot
            WHERE snapshot.product_id = ${productId}::uuid
              AND snapshot.marketplace_id = ${marketplaceId}::uuid
              AND snapshot.observed_at > halt_anchor.observed_at
            ORDER BY snapshot.observed_at DESC, snapshot.id DESC
            LIMIT 3
          ) recent
        )
      )
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
      FROM anchors
      ORDER BY observed_at, id
    `);
    return rowsOf(result).map((row) => toDomain(row as SnapshotRow));
  }

  async recoveryEpisodeAnalytics(productId: string, marketplaceId: string, episodeId: string): Promise<import("../domain/autonomous-feedback-memory.js").RecoveryEpisodeAnalytics | undefined> {
    // Keep episode-wide metrics accurate without loading every snapshot into the API process.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.db.execute(sql`
      SELECT
        COUNT(*)::integer AS snapshot_count,
        MIN(observed_at) AS started_at,
        MIN(observed_at) FILTER (WHERE recovery_state = 'recovered') AS ended_at,
        AVG(recovery_quality_score)::double precision AS average_quality_score,
        (ARRAY_AGG(conversion_count ORDER BY observed_at, id))[1] AS start_conversion_count,
        (ARRAY_AGG(attributed_commission_cents ORDER BY observed_at, id))[1] AS start_commission_cents,
        (ARRAY_AGG(recovery_clicks ORDER BY observed_at, id) FILTER (WHERE recovery_state = 'recovered'))[1] AS recovered_clicks,
        (ARRAY_AGG(conversion_count ORDER BY observed_at, id) FILTER (WHERE recovery_state = 'recovered'))[1] AS recovered_conversion_count,
        (ARRAY_AGG(attributed_commission_cents ORDER BY observed_at, id) FILTER (WHERE recovery_state = 'recovered'))[1] AS recovered_commission_cents,
        (ARRAY_AGG(recovery_quality_score ORDER BY observed_at, id) FILTER (WHERE recovery_state = 'recovered'))[1] AS closing_quality_score,
        (ARRAY_AGG(recovery_clicks ORDER BY observed_at DESC, id DESC))[1] AS latest_clicks,
        (ARRAY_AGG(conversion_count ORDER BY observed_at DESC, id DESC))[1] AS latest_conversion_count,
        (ARRAY_AGG(attributed_commission_cents ORDER BY observed_at DESC, id DESC))[1] AS latest_commission_cents
      FROM autonomous_feedback_snapshots
      WHERE product_id = ${productId}::uuid
        AND marketplace_id = ${marketplaceId}::uuid
        AND recovery_episode_id = ${episodeId}::uuid
        AND observed_at >= ${since}::timestamptz
    `);
    const row = rowsOf(result)[0];
    const snapshotCount = Number(row?.snapshot_count ?? 0);
    if (!row || snapshotCount === 0 || !row.started_at) return undefined;
    const endedAt = row.ended_at ? String(row.ended_at) : undefined;
    const lastClicks = Number(endedAt ? row.recovered_clicks : row.latest_clicks);
    const lastConversions = Number(endedAt ? row.recovered_conversion_count : row.latest_conversion_count);
    const lastCommission = Number(endedAt ? row.recovered_commission_cents : row.latest_commission_cents);
    const startedAt = String(row.started_at);
    return {
      episodeId,
      startedAt,
      endedAt,
      durationMs: endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : undefined,
      snapshotCount,
      recoveryClicks: lastClicks,
      conversionDelta: lastConversions - Number(row.start_conversion_count ?? 0),
      commissionDeltaCents: lastCommission - Number(row.start_commission_cents ?? 0),
      averageQualityScore: Number(row.average_quality_score ?? 0),
      closingQualityScore: endedAt && row.closing_quality_score !== null ? Number(row.closing_quality_score) : undefined,
      closed: Boolean(endedAt)
    };
  }

  async latestByProductAndMarketplace(productId: string, marketplaceId: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    const rows = await this.db.select().from(feedbackSnapshotsTable)
      .where(and(eq(autonomousFeedbackSnapshots.productId, productId), eq(autonomousFeedbackSnapshots.marketplaceId, marketplaceId)))
      .orderBy(desc(autonomousFeedbackSnapshots.observedAt), desc(autonomousFeedbackSnapshots.id))
      .limit(1);
    return rows[0] ? toDomain(rows[0] as SnapshotRow) : undefined;
  }
}
