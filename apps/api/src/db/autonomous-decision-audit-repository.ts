import { randomUUID } from "node:crypto";
import type { AutonomousDecisionAudit, AutonomousDecisionAuditRepository } from "../domain/autonomous-decision-audit.js";
import { autonomousDecisionAudits } from "./schema.js";
import { and, desc, eq } from "drizzle-orm";
import type { AutonomousDecisionAuditQuery, AutonomousDecisionAuditReader } from "../domain/autonomous-decision-audit.js";

type DatabaseExecutor = any;

export class DrizzleAutonomousDecisionAuditRepository implements AutonomousDecisionAuditRepository, AutonomousDecisionAuditReader {
  constructor(private readonly db: DatabaseExecutor) {}

  async list(query: AutonomousDecisionAuditQuery = {}): Promise<AutonomousDecisionAudit[]> {
    const limit = Math.min(Math.max(1, query.limit ?? 100), 500);
    const filters = [query.cycleId ? eq(autonomousDecisionAudits.cycleId, query.cycleId) : undefined, query.marketplaceId ? eq(autonomousDecisionAudits.marketplaceId, query.marketplaceId) : undefined, query.productId ? eq(autonomousDecisionAudits.productId, query.productId) : undefined, query.selected === undefined ? undefined : eq(autonomousDecisionAudits.selected, query.selected)].filter(Boolean) as any[];
    const rows = await this.db.select().from(autonomousDecisionAudits).where(filters.length ? and(...filters) : undefined).orderBy(desc(autonomousDecisionAudits.createdAt)).limit(limit);
    return rows.map((row: any) => ({ cycleId: row.cycleId, productId: row.productId, marketplaceId: row.marketplaceId, selected: row.selected, score: row.score, policy: row.policy, reasons: row.reasons, createdAt: row.createdAt }));
  }

  async saveMany(audits: AutonomousDecisionAudit[]): Promise<void> {
    if (!audits.length) return;
    await this.db.insert(autonomousDecisionAudits).values(audits.map((audit) => ({
      id: randomUUID(),
      cycleId: audit.cycleId,
      productId: audit.productId,
      marketplaceId: audit.marketplaceId,
      selected: audit.selected,
      score: audit.score,
      policy: audit.policy,
      reasons: audit.reasons,
      createdAt: audit.createdAt
    })));
  }
}
