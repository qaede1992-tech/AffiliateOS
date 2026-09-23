import type { AnalyticsOverview, CampaignAnalytics } from "./analytics.js";
import type { AutonomousFeedbackMemoryRepository } from "./autonomous-feedback-memory.js";

export type OpportunityPerformanceSignal = {
  clickCount: number;
  conversionCount: number;
  conversionRate: number;
  attributedCommissionCents: number;
  commissionPerClickCents: number;
  adjustment: number;
  trendAdjustment: number;
  confidence: number;
  scope: "marketplace" | "global";
};

export type AutonomousFeedbackContext = { observationKey?: string; };

export interface AutonomousFeedbackProvider {
  getSignals(context?: AutonomousFeedbackContext): Promise<Map<string, OpportunityPerformanceSignal>>;
}

const MINIMUM_EVIDENCE_CLICKS = 20;
const BASELINE_CONVERSION_RATE = 0.02;
const MAX_ADJUSTMENT = 8;
const MAX_TREND_ADJUSTMENT = 2;
const MAX_EFFICIENCY_ADJUSTMENT = 2;
const MIN_EFFICIENCY_EVIDENCE_CLICKS = 20;

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
    const entries = await Promise.all([...current.entries()].map(async ([key, signal]) => {
      const [marketplaceId, productId] = splitSignalKey(key);
      const previous = marketplaceId
        ? await this.memory!.latestByProductAndMarketplace(productId, marketplaceId)
        : await this.memory!.latestByProduct(productId);
      const trendAdjustment = previous && signal.clickCount > previous.clickCount
        ? calculateTrendAdjustment(signal, previous)
        : 0;
      const efficiencyAdjustment = previous && signal.clickCount >= MIN_EFFICIENCY_EVIDENCE_CLICKS
        ? calculateEfficiencyAdjustment(signal, previous)
        : 0;
      const adjustment = Math.round(clamp(signal.adjustment + trendAdjustment + efficiencyAdjustment, -MAX_ADJUSTMENT, MAX_ADJUSTMENT) * 100) / 100;
      const snapshot = {
        id: crypto.randomUUID(),
        observationKey: observationNamespace + ":" + (marketplaceId ?? "unknown") + ":" + productId,
        productId,
        marketplaceId: marketplaceId ?? previous?.marketplaceId ?? "unknown",
        clickCount: signal.clickCount,
        conversionCount: signal.conversionCount,
        attributedCommissionCents: signal.attributedCommissionCents,
        commissionPerClickCents: signal.commissionPerClickCents,
        conversionRate: signal.conversionRate,
        adjustment,
        observedAt
      };
      if (this.memory!.saveIfAbsent) await this.memory!.saveIfAbsent(snapshot);
      else await this.memory!.save(snapshot);
      return [key, { ...signal, adjustment, trendAdjustment: Math.round((trendAdjustment + efficiencyAdjustment) * 100) / 100 }] as const;
    }));
    return new Map(entries);
  }
}

export function buildSignals(overview: AnalyticsOverview): Map<string, OpportunityPerformanceSignal> {
  const grouped = new Map<string, CampaignAnalytics[]>();
  const categoryGrouped = new Map<string, CampaignAnalytics[]>();
  const audienceGrouped = new Map<string, CampaignAnalytics[]>();
  const globalCategoryGrouped = new Map<string, CampaignAnalytics[]>();
  const globalAudienceGrouped = new Map<string, CampaignAnalytics[]>();
  for (const campaign of overview.campaigns) {
    if (!campaign.productId) continue;
    const key = campaign.marketplaceId ? signalKey(campaign.marketplaceId, campaign.productId) : campaign.productId;
    const current = grouped.get(key) ?? [];
    current.push(campaign);
    grouped.set(key, current);
    const category = campaign.category?.trim().toLowerCase();
    if (category) {
      const categoryKey = categorySignalKey(campaign.marketplaceId, category);
      const globalCategory = globalCategoryGrouped.get("global:category:" + category) ?? [];
      globalCategory.push(campaign); globalCategoryGrouped.set("global:category:" + category, globalCategory);
      const categoryCurrent = categoryGrouped.get(categoryKey) ?? [];
      categoryCurrent.push(campaign);
      categoryGrouped.set(categoryKey, categoryCurrent);
    }
    for (const segment of campaign.audienceSegments ?? []) {
      const normalized = segment.trim().toLowerCase();
      if (!normalized) continue;
      const audienceKey = audienceSignalKey(campaign.marketplaceId, normalized);
      const globalAudience = globalAudienceGrouped.get("global:audience:" + normalized) ?? [];
      globalAudience.push(campaign); globalAudienceGrouped.set("global:audience:" + normalized, globalAudience);
      const audienceCurrent = audienceGrouped.get(audienceKey) ?? [];
      audienceCurrent.push(campaign);
      audienceGrouped.set(audienceKey, audienceCurrent);
    }
  }
  const signals = new Map<string, OpportunityPerformanceSignal>();
  for (const [key, campaigns] of grouped) {
    const clicks = campaigns.reduce((sum, item) => sum + item.clickCount, 0);
    const conversions = campaigns.reduce((sum, item) => sum + item.attributedConversionCount, 0);
    const commission = campaigns.reduce((sum, item) => sum + item.attributedCommissionCents, 0);
    const commissionPerClickCents = clicks === 0 ? 0 : commission / clicks;
    const conversionRate = clicks === 0 ? 0 : conversions / clicks;
    const adjustment = clicks < MINIMUM_EVIDENCE_CLICKS
      ? 0
      : clamp(((conversionRate - BASELINE_CONVERSION_RATE) / BASELINE_CONVERSION_RATE) * MAX_ADJUSTMENT, -MAX_ADJUSTMENT, MAX_ADJUSTMENT);
    signals.set(key, {
      clickCount: clicks,
      conversionCount: conversions,
      conversionRate,
      attributedCommissionCents: commission,
      commissionPerClickCents,
      adjustment: Math.round(adjustment * 100) / 100,
      trendAdjustment: 0,
      confidence: confidenceForClicks(clicks),
      scope: "marketplace"
    });
  }
  for (const [key, campaigns] of categoryGrouped) signals.set(key, aggregateSignals(campaigns));
  for (const [key, campaigns] of audienceGrouped) signals.set(key, aggregateSignals(campaigns));
  for (const [key, campaigns] of globalCategoryGrouped) signals.set(key, { ...aggregateSignals(campaigns), scope: "global" });
  for (const [key, campaigns] of globalAudienceGrouped) signals.set(key, { ...aggregateSignals(campaigns), scope: "global" });
  return signals;
}

function aggregateSignals(campaigns: CampaignAnalytics[]): OpportunityPerformanceSignal {
  const clicks = campaigns.reduce((sum, item) => sum + item.clickCount, 0);
  const conversions = campaigns.reduce((sum, item) => sum + item.attributedConversionCount, 0);
  const commission = campaigns.reduce((sum, item) => sum + item.attributedCommissionCents, 0);
  const commissionPerClickCents = clicks === 0 ? 0 : commission / clicks;
  const conversionRate = clicks === 0 ? 0 : conversions / clicks;
  const adjustment = clicks < MINIMUM_EVIDENCE_CLICKS ? 0 : clamp(((conversionRate - BASELINE_CONVERSION_RATE) / BASELINE_CONVERSION_RATE) * MAX_ADJUSTMENT, -MAX_ADJUSTMENT, MAX_ADJUSTMENT);
  return { clickCount: clicks, conversionCount: conversions, conversionRate, attributedCommissionCents: commission, commissionPerClickCents, adjustment: Math.round(adjustment * 100) / 100, trendAdjustment: 0, confidence: confidenceForClicks(clicks), scope: "marketplace" };
}

function categorySignalKey(marketplaceId: string | undefined, category: string): string { return `${marketplaceId ?? "unknown"}:category:${category}`; }
function audienceSignalKey(marketplaceId: string | undefined, audience: string): string { return `${marketplaceId ?? "unknown"}:audience:${audience}`; }

function signalKey(marketplaceId: string, productId: string): string {
  return marketplaceId + ":" + productId;
}

function splitSignalKey(key: string): [string | undefined, string] {
  const separator = key.indexOf(":");
  return separator < 0 ? [undefined, key] : [key.slice(0, separator), key.slice(separator + 1)];
}

function confidenceForClicks(clicks: number): number { return Math.min(1, Math.sqrt(Math.max(0, clicks) / MINIMUM_EVIDENCE_CLICKS)); }

function calculateEfficiencyAdjustment(current: OpportunityPerformanceSignal, previous: { clickCount: number; commissionPerClickCents: number }): number {
  if (previous.clickCount < MIN_EFFICIENCY_EVIDENCE_CLICKS || previous.commissionPerClickCents <= 0) return 0;
  const relativeChange = (current.commissionPerClickCents - previous.commissionPerClickCents) / previous.commissionPerClickCents;
  return clamp(relativeChange * MAX_EFFICIENCY_ADJUSTMENT, -MAX_EFFICIENCY_ADJUSTMENT, MAX_EFFICIENCY_ADJUSTMENT);
}

function calculateTrendAdjustment(current: OpportunityPerformanceSignal, previous: { clickCount: number; conversionCount: number; conversionRate: number }): number {
  const incrementalClicks = current.clickCount - previous.clickCount;
  if (incrementalClicks <= 0) return 0;
  const incrementalConversions = Math.max(0, current.conversionCount - previous.conversionCount);
  const incrementalRate = incrementalConversions / incrementalClicks;
  return clamp(((incrementalRate - previous.conversionRate) / Math.max(previous.conversionRate, BASELINE_CONVERSION_RATE)) * MAX_TREND_ADJUSTMENT, -MAX_TREND_ADJUSTMENT, MAX_TREND_ADJUSTMENT);
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
