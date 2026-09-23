import type { OpportunitySelectionAudit } from "./autonomous-opportunity.js";

export type AutonomousDecisionAudit = OpportunitySelectionAudit & {
  cycleId: string;
  createdAt: string;
};

export interface AutonomousDecisionAuditRepository {
  saveMany(audits: AutonomousDecisionAudit[]): Promise<void>;
}
