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
        conversionRate: snapshot.conversionRate,
        adjustment: snapshot.adjustment,
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
      .orderBy(desc(autonomousFeedbackSnapshots.observedAt), desc(autonomousFeedbackSnapshots.id));
    return rows.map(toDomain);
  }

  async latestByProductAndMarketplace(productId: string, marketplaceId: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    const rows = await this.db.select().from(autonomousFeedbackSnapshots)
      .where(and(eq(autonomousFeedbackSnapshots.productId, productId), eq(autonomousFeedbackSnapshots.marketplaceId, marketplaceId)))
      .orderBy(desc(autonomousFeedbackSnapshots.observedAt), desc(autonomousFeedbackSnapshots.id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }
}
