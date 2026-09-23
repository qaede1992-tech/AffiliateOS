import type { AutonomousDecisionAudit, AutonomousDecisionOutcomeAnalytics } from "./autonomous-decision-audit.js";

export type ExplorationEvaluation = {
  status: "insufficient-evidence" | "promote-to-exploitation" | "continue-exploration" | "deprioritize";
  reason: string;
  confidence: number;
};

export type ExplorationEvaluationPolicy = {
  minimumClicks?: number;
  promotionConversionRate?: number;
  minimumCommissionPerClickCents?: number;
  deprioritizeConversionRate?: number;
};

export function evaluateExploration(
  audit: AutonomousDecisionAudit,
  policy: ExplorationEvaluationPolicy = {}
): ExplorationEvaluation | undefined {
  if (audit.selectionMode !== "exploration" || !audit.outcome?.analytics) return undefined;
  const analytics = audit.outcome.analytics;
  const minimumClicks = Math.max(1, policy.minimumClicks ?? 20);
  const promotionConversionRate = Math.max(0, policy.promotionConversionRate ?? 0.02);
  const minimumCommissionPerClickCents = Math.max(0, policy.minimumCommissionPerClickCents ?? 0);
  const deprioritizeConversionRate = Math.max(0, policy.deprioritizeConversionRate ?? 0.01);
  if (analytics.clickCount < minimumClicks) {
    return { status: "insufficient-evidence", reason: `Only ${analytics.clickCount} clicks; minimum evidence is ${minimumClicks}`, confidence: Math.min(1, analytics.clickCount / minimumClicks) };
  }
  const commissionPerClick = analytics.clickCount === 0 ? 0 : analytics.attributedCommissionCents / analytics.clickCount;
  if (analytics.conversionRate >= promotionConversionRate && commissionPerClick >= minimumCommissionPerClickCents) {
    return { status: "promote-to-exploitation", reason: `Conversion rate ${analytics.conversionRate.toFixed(4)} and commission/click ${commissionPerClick.toFixed(2)} meet promotion thresholds`, confidence: confidenceFromEvidence(analytics.clickCount, minimumClicks) };
  }
  if (analytics.conversionRate <= deprioritizeConversionRate && commissionPerClick < minimumCommissionPerClickCents) {
    return { status: "deprioritize", reason: `Conversion rate ${analytics.conversionRate.toFixed(4)} and commission/click ${commissionPerClick.toFixed(2)} are below exploration thresholds`, confidence: confidenceFromEvidence(analytics.clickCount, minimumClicks) };
  }
  return { status: "continue-exploration", reason: `Evidence is sufficient but performance is between promotion and deprioritization thresholds`, confidence: confidenceFromEvidence(analytics.clickCount, minimumClicks) };
}

function confidenceFromEvidence(clicks: number, minimumClicks: number): number {
  return Math.round(Math.min(1, Math.sqrt(clicks / minimumClicks)) * 100) / 100;
}
