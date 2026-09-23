import type { ExplorationEvaluation } from "./exploration-evaluator.js";
import type { OpportunitySelectionAudit } from "./autonomous-opportunity.js";

export type AutonomousDecisionAudit = OpportunitySelectionAudit & {
  cycleId: string;
  createdAt: string;
  recovery?: AutonomousDecisionRecovery;
  outcome?: AutonomousDecisionOutcome;
};

export type AutonomousDecisionRecovery = {
  anomaly: "none" | "watch" | "halt";
  recoveryState: "none" | "recovering" | "recovered";
  recoveryClicks: number;
  recoveryEvidenceScore: number;
  recoveryEpisodeId?: string;
};

export type AutonomousDecisionOutcome = {
  offerId?: string;
  status: "completed" | "failed";
  campaignId?: string;
  error?: string;
  observedAt: string;
  analytics?: AutonomousDecisionOutcomeAnalytics;
  explorationEvaluation?: ExplorationEvaluation;
};

export type AutonomousDecisionOutcomeAnalytics = {
  clickCount: number;
  attributedConversionCount: number;
  attributedRevenueCents: number;
  attributedCommissionCents: number;
  conversionRate: number;
};

export interface AutonomousDecisionAuditRepository {
  saveMany(audits: AutonomousDecisionAudit[]): Promise<void>;
  updateOutcome(auditId: string, outcome: AutonomousDecisionOutcome): Promise<void>;
  updateExplorationEvaluation?(auditId: string, evaluation: import("./exploration-evaluator.js").ExplorationEvaluation): Promise<void>;
}

export type AutonomousDecisionAuditQuery = { cycleId?: string; marketplaceId?: string; productId?: string; selected?: boolean; limit?: number };
export interface AutonomousDecisionAuditReader { list(query?: AutonomousDecisionAuditQuery): Promise<AutonomousDecisionAudit[]>; }
