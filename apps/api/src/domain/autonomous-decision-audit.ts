import type { OpportunitySelectionAudit } from "./autonomous-opportunity.js";

export type AutonomousDecisionAudit = OpportunitySelectionAudit & {
  cycleId: string;
  createdAt: string;
};

export interface AutonomousDecisionAuditRepository {
  saveMany(audits: AutonomousDecisionAudit[]): Promise<void>;
}

export type AutonomousDecisionAuditQuery = { cycleId?: string; marketplaceId?: string; productId?: string; selected?: boolean; limit?: number };
export interface AutonomousDecisionAuditReader { list(query?: AutonomousDecisionAuditQuery): Promise<AutonomousDecisionAudit[]>; }
