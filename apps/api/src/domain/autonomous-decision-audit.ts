import type { ExplorationEvaluation } from "./exploration-evaluator.js";
import type { OpportunitySelectionAudit } from "./autonomous-opportunity.js";

export type AutonomousDecisionAudit = OpportunitySelectionAudit & {
  performanceRegime?: "rising" | "stable" | "declining" | "volatile";
  performanceRegimeConfidence?: number;
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
  episodeMetrics?: {
    recoveryDurationMs: number;
    recoveryClicks: number;
    conversionDelta: number;
    commissionDeltaCents: number;
    qualityScore?: number;
    previousEpisodeQualityScore?: number;
    qualityDelta?: number;
  };
  policy?: {
    explorationFloor: number;
    direction: "hold-exploration" | "reduce-exploration" | "neutral";
    qualityDelta?: number;
  };
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

export interface AutonomousDecisionAuditQuery {
  cycleId?: string;
  marketplaceId?: string;
  productId?: string;
  recoveryEpisodeId?: string;
  selected?: boolean;
  limit?: number;
}

export interface AutonomousDecisionAuditReader {
  list(query?: AutonomousDecisionAuditQuery): Promise<AutonomousDecisionAudit[]>;
}

export interface AutonomousDecisionAuditRepository extends AutonomousDecisionAuditReader {
  saveMany(audits: AutonomousDecisionAudit[]): Promise<void>;
  updateOutcome(auditId: string, outcome: AutonomousDecisionOutcome): Promise<void>;
  updateExplorationEvaluation?(
    auditId: string,
    evaluation: ExplorationEvaluation
  ): Promise<void>;
}
