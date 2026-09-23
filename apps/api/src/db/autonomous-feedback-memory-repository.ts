import { desc, eq, and, gte } from "drizzle-orm";
import type { AutonomousFeedbackMemoryRepository, AutonomousFeedbackSnapshot } from "../domain/autonomous-feedback-memory.js";
import { autonomousFeedbackSnapshots } from "./schema.js";

type DatabaseExecutor = any;
type SnapshotRow = typeof autonomousFeedbackSnapshots.$inferSelect;

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
  recoveryQualityScore: row.recoveryQualityScore ?? 0,\n  recoveryPolicy: row.recoveryPolicy as AutonomousFeedbackSnapshot["recoveryPolicy"],
  recoveryEpisodeId: row.recoveryEpisodeId ?? undefined,
  observedAt: row.observedAt
});

export class DrizzleAutonomousFeedbackMemoryRepository implements AutonomousFeedbackMemoryRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async save(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot> {
    await this.db.insert(autonomousFeedbackSnapshots).values({
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
      recoveryQualityScore: snapshot.recoveryQualityScore,\n      recoveryPolicy: snapshot.recoveryPolicy,
      recoveryQualityScore: snapshot.recoveryQualityScore,\n      recoveryEpisodeId: snapshot.recoveryEpisodeId,
      observedAt: snapshot.observedAt
    });
    return snapshot;
  }

  async saveIfAbsent(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot> {
    const rows = await this.db.insert(autonomousFeedbackSnapshots)
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
        recoveryEpisodeId: snapshot.recoveryEpisodeId,
        observedAt: snapshot.observedAt
      })
      .onConflictDoNothing({ target: autonomousFeedbackSnapshots.observationKey })
      .returning();
    if (rows[0]) return toDomain(rows[0]);
    const existing = await this.latestByObservationKey(snapshot.observationKey);
    if (!existing) throw new Error("Autonomous feedback snapshot insert was skipped but no observation was found.");
    return existing;
  }

  private async latestByObservationKey(observationKey: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    const rows = await this.db.select().from(autonomousFeedbackSnapshots)
      .where(eq(autonomousFeedbackSnapshots.observationKey, observationKey))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async latestByProduct(productId: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    const rows = await this.db.select().from(autonomousFeedbackSnapshots)
      .where(eq(autonomousFeedbackSnapshots.productId, productId))
      .orderBy(desc(autonomousFeedbackSnapshots.observedAt), desc(autonomousFeedbackSnapshots.id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async recentByProductAndMarketplace(productId: string, marketplaceId: string, since: string): Promise<AutonomousFeedbackSnapshot[]> {
    const rows = await this.db.select().from(autonomousFeedbackSnapshots)
      .where(and(eq(autonomousFeedbackSnapshots.productId, productId), eq(autonomousFeedbackSnapshots.marketplaceId, marketplaceId), gte(autonomousFeedbackSnapshots.observedAt, since)))
      .orderBy(autonomousFeedbackSnapshots.observedAt, autonomousFeedbackSnapshots.id);
    return rows.map(toDomain);
  }

  async recoveryEpisodeAnalytics(productId: string, marketplaceId: string, episodeId: string): Promise<import("../domain/autonomous-feedback-memory.js").RecoveryEpisodeAnalytics | undefined> {\n    const snapshots = await this.recentByProductAndMarketplace(productId, marketplaceId, new Date(Date.now()-30*24*60*60*1000).toISOString());\n    const episode = snapshots.filter(s=>s.recoveryEpisodeId===episodeId); const start=episode[0]; if(!start) return undefined; const end=episode.find(s=>s.recoveryState==="recovered"); const last=end??episode.at(-1)!;\n    return {episodeId,startedAt:start.observedAt,endedAt:end?.observedAt,durationMs:end?Math.max(0,Date.parse(end.observedAt)-Date.parse(start.observedAt)):undefined,snapshotCount:episode.length,recoveryClicks:last.recoveryClicks,conversionDelta:last.conversionCount-start.conversionCount,commissionDeltaCents:last.attributedCommissionCents-start.attributedCommissionCents,averageQualityScore:episode.reduce((sum,s)=>sum+s.recoveryQualityScore,0)/episode.length,closingQualityScore:end?.recoveryQualityScore,closed:Boolean(end)};\n  }\n\n  async latestByProductAndMarketplace(productId: string, marketplaceId: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    const rows = await this.db.select().from(autonomousFeedbackSnapshots)
      .where(and(eq(autonomousFeedbackSnapshots.productId, productId), eq(autonomousFeedbackSnapshots.marketplaceId, marketplaceId)))
      .orderBy(desc(autonomousFeedbackSnapshots.observedAt), desc(autonomousFeedbackSnapshots.id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }
}
