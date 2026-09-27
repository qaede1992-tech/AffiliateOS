import type { AnalyticsOverview } from "./analytics.js";
import { buildSignals, type OpportunityPerformanceSignal } from "./autonomous-feedback.js";

export type PerformanceIndexEntry = {
  key: string;
  scope: "product" | "category" | "audience";
  index: number;
  adjustment: number;
  confidence: number;
  clickCount: number;
  conversionCount: number;
  conversionRate: number;
  attributedCommissionCents: number;
  commissionPerClickCents: number;
  regime?: OpportunityPerformanceSignal["regime"];
  regimeConfidence?: number;
  anomaly?: OpportunityPerformanceSignal["anomaly"];
  anomalyScore?: number;
  anomalyRecovery?: OpportunityPerformanceSignal["anomalyRecovery"];
};

const INDEX_BASE = 50;
const MAX_ADJUSTMENT = 8;

function normalizeIndex(adjustment: number): number {
  const bounded = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, Number.isFinite(adjustment) ? adjustment : 0));
  return Math.round((INDEX_BASE + (bounded / MAX_ADJUSTMENT) * 50) * 100) / 100;
}

function scopeForKey(key: string): PerformanceIndexEntry["scope"] {
  if (key.includes(":category:")) return "category";
  if (key.includes(":audience:")) return "audience";
  return "product";
}

export function buildPerformanceIndex(overview: AnalyticsOverview): PerformanceIndexEntry[] {
  const signals = buildSignals(overview);
  return [...signals.entries()]
    .filter(([key]) => !key.startsWith("global:"))
    .map(([key, signal]) => ({
      key,
      scope: scopeForKey(key),
      index: normalizeIndex(signal.adjustment),
      adjustment: signal.adjustment,
      confidence: signal.confidence ?? 0,
      clickCount: signal.clickCount,
      conversionCount: signal.conversionCount,
      conversionRate: signal.conversionRate,
      attributedCommissionCents: signal.attributedCommissionCents,
      commissionPerClickCents: signal.commissionPerClickCents,
      regime: signal.regime,
      regimeConfidence: signal.regimeConfidence,
      anomaly: signal.anomaly,
      anomalyScore: signal.anomalyScore,
      anomalyRecovery: signal.anomalyRecovery
    }))
    .sort((a, b) => b.index - a.index || a.key.localeCompare(b.key));
}
