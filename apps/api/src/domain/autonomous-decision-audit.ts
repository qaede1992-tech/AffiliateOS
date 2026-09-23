import type { OpportunitySelectionAudit } from "./autonomous-opportunity.js";

export type AutonomousDecisionAudit = OpportunitySelectionAudit & {
  cycleId: string;
  createdAt: string;
  outcome?: AutonomousDecisionOutcome;
};

export type AutonomousDecisionOutcome = {
  offerId?: string;
  status: "completed" | "failed";
  campaignId?: string;
  error?: string;
  observedAt: string;
};

export interface AutonomousDecisionAuditRepository {
  saveMany(audits: AutonomousDecisionAudit[]): Promise<void>;
  updateOutcome(auditId: string, outcome: AutonomousDecisionOutcome): Promise<void>;
}

export type AutonomousDecisionAuditQuery = { cycleId?: string; marketplaceId?: string; productId?: string; selected?: boolean; limit?: number };
export interface AutonomousDecisionAuditReader { list(query?: AutonomousDecisionAuditQuery): Promise<AutonomousDecisionAudit[]>; }
