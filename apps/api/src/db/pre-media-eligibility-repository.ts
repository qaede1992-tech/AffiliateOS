import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { PreMediaEligibilityEvidence, PreMediaEligibilityRepository } from "../domain/pre-media-eligibility.js";
import { preMediaEligibilityEvidence } from "./schema.js";

type DatabaseExecutor = any;

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
};

const evidenceFingerprint = (record: PreMediaEligibilityEvidence): string => createHash("sha256")
  .update(JSON.stringify(stableValue({
    productId: record.productId,
    marketplaceId: record.marketplaceId,
    offerId: record.offerId ?? null,
    eligible: record.eligible,
    score: record.score,
    policy: record.policy,
    reasons: record.reasons
  })))
  .digest("hex");

export class DrizzlePreMediaEligibilityRepository implements PreMediaEligibilityRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async saveMany(records: PreMediaEligibilityEvidence[]): Promise<void> {
    if (!records.length) return;
    const rows = records.map((record) => ({
      ...record,
      policy: record.policy,
      reasons: record.reasons,
      fingerprint: evidenceFingerprint(record)
    }));
    // A unique fingerprint makes repeated cycles idempotent while retaining a
    // new append-only evidence row whenever eligibility, score, policy or reasons change.
    await this.db.insert(preMediaEligibilityEvidence).values(rows).onConflictDoNothing();
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
