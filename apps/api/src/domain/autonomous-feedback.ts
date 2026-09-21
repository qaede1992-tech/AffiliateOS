import type { AnalyticsOverview, CampaignAnalytics } from "./analytics.js";
import type { AutonomousFeedbackMemoryRepository } from "./autonomous-feedback-memory.js";

export type OpportunityPerformanceSignal = {
  clickCount: number;
  conversionCount: number;
  conversionRate: number;
  attributedCommissionCents: number;
  adjustment: number;
  trendAdjustment: number;
};

export type AutonomousFeedbackContext = {
  observationKey?: string;
};

export interface AutonomousFeedbackProvider { getSignals(context?: AutonomousFeedbackContext): Promise<Map<string, OpportunityPerformanceSignal>>; }

const MINIMUM_EVIDENCE_CLICKS = 20;
const BASELINE_CONVERSION_RATE = 0.02;
const MAX_ADJUSTMENT = 8;
const MAX_TREND_ADJUSTMENT = 2;

export class AutonomousAnalyticsFeedbackProvider implements AutonomousFeedbackProvider {
  constructor(
    private readonly analytics: { overview(): Promise<AnalyticsOverview> },
    private readonly memory?: AutonomousFeedbackMemoryRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async getSignals(context: AutonomousFeedbackContext = {}): Promise<Map<string, OpportunityPerformanceSignal>> {
    const current = buildSignals(await this.analytics.overview());
    if (!this.memory) return current;
    const observedAt = this.now().toISOString();
    const observationNamespace = context.observationKey?.trim() || observedAt;
    const entries = await Promise.all([...current.entries()].map(async ([productId, signal]) => {
      const previous = await this.memory!.latestByProduct(productId);
      const trendAdjustment = previous && signal.clickCount > previous.clickCount
        ? calculateTrendAdjustment(signal, previous)
        : 0;
      const adjustment = Math.round(clamp(signal.adjustment + trendAdjustment, -MAX_ADJUSTMENT, MAX_ADJUSTMENT) * 100) / 100;
      const snapshot = {
        id: crypto.randomUUID(),
        observationKey: `${observationNamespace}:${productId}`,
        productId,
        clickCount: signal.clickCount,
        conversionCount: signal.conversionCount,
        attributedCommissionCents: signal.attributedCommissionCents,
        conversionRate: signal.conversionRate,
        adjustment,
        observedAt
      };
      if (this.memory!.saveIfAbsent) await this.memory!.saveIfAbsent(snapshot);
      else await this.memory!.save(snapshot);
      return [productId, { ...signal, adjustment, trendAdjustment: Math.round(trendAdjustment * 100) / 100 }] as const;
    }));
    return new Map(entries);
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
    signals.set(productId, { clickCount: clicks, conversionCount: conversions, conversionRate, attributedCommissionCents: commission, adjustment: Math.round(adjustment * 100) / 100, trendAdjustment: 0 });
  }
  return signals;
}

function calculateTrendAdjustment(current: OpportunityPerformanceSignal, previous: { clickCount: number; conversionCount: number; conversionRate: number }): number {
  const incrementalClicks = current.clickCount - previous.clickCount;
  if (incrementalClicks <= 0) return 0;
  const incrementalConversions = Math.max(0, current.conversionCount - previous.conversionCount);
  const incrementalRate = incrementalConversions / incrementalClicks;
  return clamp(((incrementalRate - previous.conversionRate) / Math.max(previous.conversionRate, BASELINE_CONVERSION_RATE)) * MAX_TREND_ADJUSTMENT, -MAX_TREND_ADJUSTMENT, MAX_TREND_ADJUSTMENT);
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
