import { desc, eq } from "drizzle-orm";
import type { PreMediaEligibilityEvidence, PreMediaEligibilityRepository } from "../domain/pre-media-eligibility.js";
import { preMediaEligibilityEvidence } from "./schema.js";

type DatabaseExecutor = any;

export class DrizzlePreMediaEligibilityRepository implements PreMediaEligibilityRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async saveMany(records: PreMediaEligibilityEvidence[]): Promise<void> {
    if (!records.length) return;
    await this.db.insert(preMediaEligibilityEvidence).values(records.map((record) => ({
      ...record,
      policy: record.policy,
      reasons: record.reasons
    })));
  }

  async listLatestByProduct(productId: string, limit = 5): Promise<PreMediaEligibilityEvidence[]> {
    const boundedLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
    const rows = await this.db.select().from(preMediaEligibilityEvidence)
      .where(eq(preMediaEligibilityEvidence.productId, productId))
      .orderBy(desc(preMediaEligibilityEvidence.createdAt), desc(preMediaEligibilityEvidence.id))
      .limit(boundedLimit);
    return rows.map((row: typeof preMediaEligibilityEvidence.$inferSelect) => ({
      id: row.id,
      cycleId: row.cycleId,
      productId: row.productId,
      marketplaceId: row.marketplaceId,
      offerId: row.offerId ?? undefined,
      eligible: row.eligible,
      score: row.score,
      policy: row.policy,
      reasons: row.reasons,
      createdAt: row.createdAt
    }));
  }
}
