import type { AnalyticsOverview, CampaignAnalytics } from "./analytics.js";

export type OpportunityPerformanceSignal = {
  clickCount: number;
  conversionRate: number;
  attributedCommissionCents: number;
  adjustment: number;
};

export interface AutonomousFeedbackProvider {
  getSignals(): Promise<Map<string, OpportunityPerformanceSignal>>;
}

const MINIMUM_EVIDENCE_CLICKS = 20;
const BASELINE_CONVERSION_RATE = 0.02;
const MAX_ADJUSTMENT = 8;

export class AutonomousAnalyticsFeedbackProvider implements AutonomousFeedbackProvider {
  constructor(private readonly analytics: { overview(): Promise<AnalyticsOverview> }) {}

  async getSignals(): Promise<Map<string, OpportunityPerformanceSignal>> {
    return buildSignals(await this.analytics.overview());
  }
}

export function buildSignals(overview: AnalyticsOverview): Map<string, OpportunityPerformanceSignal> {
  const grouped = new Map<string, CampaignAnalytics[]>();
  for (const campaign of overview.campaigns) {
    if (!campaign.productId) continue;
    const current = grouped.get(campaign.productId) ?? [];
    current.push(campaign);
    grouped.set(campaign.productId, current);
  }

  const signals = new Map<string, OpportunityPerformanceSignal>();
  for (const [productId, campaigns] of grouped) {
    const clicks = campaigns.reduce((sum, item) => sum + item.clickCount, 0);
    const conversions = campaigns.reduce((sum, item) => sum + item.attributedConversionCount, 0);
    const commission = campaigns.reduce((sum, item) => sum + item.attributedCommissionCents, 0);
    const conversionRate = clicks === 0 ? 0 : conversions / clicks;
    const adjustment = clicks < MINIMUM_EVIDENCE_CLICKS
      ? 0
      : clamp(((conversionRate - BASELINE_CONVERSION_RATE) / BASELINE_CONVERSION_RATE) * MAX_ADJUSTMENT, -MAX_ADJUSTMENT, MAX_ADJUSTMENT);
    signals.set(productId, {
      clickCount: clicks,
      conversionRate,
      attributedCommissionCents: commission,
      adjustment: Math.round(adjustment * 100) / 100
    });
  }
  return signals;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
