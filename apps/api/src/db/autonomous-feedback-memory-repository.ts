import { desc, eq } from "drizzle-orm";
import type { AutonomousFeedbackMemoryRepository, AutonomousFeedbackSnapshot } from "../domain/autonomous-feedback-memory.js";
import { autonomousFeedbackSnapshots } from "./schema.js";

type DatabaseExecutor = any;
type SnapshotRow = typeof autonomousFeedbackSnapshots.$inferSelect;

const toDomain = (row: SnapshotRow): AutonomousFeedbackSnapshot => ({
  id: row.id,
  productId: row.productId,
  clickCount: row.clickCount,
  conversionCount: row.conversionCount,
  attributedCommissionCents: row.attributedCommissionCents,
  conversionRate: row.conversionRate,
  adjustment: row.adjustment,
  observedAt: row.observedAt
});

export class DrizzleAutonomousFeedbackMemoryRepository implements AutonomousFeedbackMemoryRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async save(snapshot: AutonomousFeedbackSnapshot): Promise<AutonomousFeedbackSnapshot> {
    await this.db.insert(autonomousFeedbackSnapshots).values({
      id: snapshot.id,
      productId: snapshot.productId,
      clickCount: snapshot.clickCount,
      conversionCount: snapshot.conversionCount,
      attributedCommissionCents: snapshot.attributedCommissionCents,
      conversionRate: snapshot.conversionRate,
      adjustment: snapshot.adjustment,
      observedAt: snapshot.observedAt
    });
    return snapshot;
  }

  async latestByProduct(productId: string): Promise<AutonomousFeedbackSnapshot | undefined> {
    const rows = await this.db.select().from(autonomousFeedbackSnapshots)
      .where(eq(autonomousFeedbackSnapshots.productId, productId))
      .orderBy(desc(autonomousFeedbackSnapshots.observedAt))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }
}
