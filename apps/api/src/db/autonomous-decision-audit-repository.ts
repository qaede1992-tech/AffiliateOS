import { randomUUID } from "node:crypto";
import type { AutonomousDecisionAudit, AutonomousDecisionAuditRepository } from "../domain/autonomous-decision-audit.js";
import { autonomousDecisionAudits } from "./schema.js";

type DatabaseExecutor = any;

export class DrizzleAutonomousDecisionAuditRepository implements AutonomousDecisionAuditRepository {
  constructor(private readonly db: DatabaseExecutor) {}

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
