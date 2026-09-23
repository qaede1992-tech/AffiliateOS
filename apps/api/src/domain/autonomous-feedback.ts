import type { AnalyticsOverview, CampaignAnalytics } from "./analytics.js";
import type { AutonomousFeedbackMemoryRepository, AutonomousFeedbackSnapshot } from "./autonomous-feedback-memory.js";

export type PerformanceWindow = { clickCount:number; conversionCount:number; conversionRate:number; confidence:number; };
export type PerformanceRegime = "rising" | "stable" | "declining" | "volatile";
export type PerformanceAnomaly = "none" | "watch" | "halt";
export type AnomalyRecoveryState = "none" | "recovering" | "recovered";


export type OpportunityPerformanceSignal = {
  clickCount: number;
  conversionCount: number;
  conversionRate: number;
  attributedCommissionCents: number;
  commissionPerClickCents: number;
  adjustment: number;
  trendAdjustment: number;
  confidence?: number;
  scope?: "marketplace" | "global";
  windows?: { "24h": PerformanceWindow; "7d": PerformanceWindow; "30d": PerformanceWindow };
  regime?: PerformanceRegime;
  regimeConfidence?: number;
  anomaly?: PerformanceAnomaly;
  anomalyScore?: number;
  anomalyRecovery?: AnomalyRecoveryState;
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
const ANOMALY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ANOMALY_RECOVERY_CLICKS = 20;
const ANOMALY_RECOVERY_MIN_CONFIDENCE = 0.5;
const ANOMALY_RECOVERY_MAX_SCORE = 0.45;
const ANOMALY_RECOVERY_MAX_RATE_DIVERGENCE = 0.04;
const LEARNING_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

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
      const freshness = previous ? learningFreshness(previous.observedAt, observedAt) : 0;
      const trendAdjustment = previous && signal.clickCount > previous.clickCount
        ? calculateTrendAdjustment(signal, previous) * freshness
        : 0;
      const efficiencyAdjustment = previous && signal.clickCount >= MIN_EFFICIENCY_EVIDENCE_CLICKS
        ? calculateEfficiencyAdjustment(signal, previous) * freshness
        : 0;
      const isProductSignal = !key.startsWith("global:") && !key.includes(":category:") && !key.includes(":audience:");
      const windows = isProductSignal && this.memory!.recentByProductAndMarketplace
        ? await buildWindows(this.memory!.recentByProductAndMarketplace.bind(this.memory!), productId, marketplaceId!, signal, observedAt)
        : undefined;
      const regime = windows ? classifyWindowRegime(windows) : "stable";
      const regimeConfidence = windows ? calculateRegimeConfidence(windows, regime) : 0;
      const anomalyScore = windows ? calculateAnomalyScore(windows) : 0;
      const elapsedSincePrevious = previous ? Date.parse(observedAt) - Date.parse(previous.observedAt) : Number.POSITIVE_INFINITY;
      const recentHalt = previous?.anomaly === "halt" && elapsedSincePrevious < ANOMALY_COOLDOWN_MS;
      const recoveryAnchor = isProductSignal && this.memory!.recentByProductAndMarketplace
        ? await latestHaltSnapshot(this.memory!.recentByProductAndMarketplace.bind(this.memory!), productId, marketplaceId!, observedAt)
        : undefined;
      const recoveryClicks = recoveryAnchor ? Math.max(0, signal.clickCount - recoveryAnchor.clickCount) : ANOMALY_RECOVERY_CLICKS;
      const recoveryEvidence = windows
        ? hasRecoveryEvidence(windows, recoveryClicks, anomalyScore)
        : recoveryClicks >= ANOMALY_RECOVERY_CLICKS;
      const recoveryGate = Boolean(recoveryAnchor) && elapsedSincePrevious >= ANOMALY_COOLDOWN_MS && !recoveryEvidence;
      const anomaly = recentHalt || recoveryGate ? "halt" : classifyAnomaly(anomalyScore);
      const anomalyRecovery: AnomalyRecoveryState = recoveryAnchor
        ? (recentHalt ? "recovering" : recoveryGate ? "recovering" : "recovered")
        : "none";
      const windowAdjustment = windows && anomaly !== "halt"
        ? calculateWindowAdjustment(windows, regime) * regimeConfidence * (anomaly === "watch" ? 0.35 : 1)
        : 0;
      const adjustment = Math.round(clamp(signal.adjustment + trendAdjustment + efficiencyAdjustment + windowAdjustment, -MAX_ADJUSTMENT, MAX_ADJUSTMENT) * 100) / 100;
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
        anomaly,
        anomalyScore,
        observedAt
      };
      if (this.memory!.saveIfAbsent) await this.memory!.saveIfAbsent(snapshot);
      else await this.memory!.save(snapshot);
      return [key, { ...signal, adjustment, trendAdjustment: Math.round((trendAdjustment + efficiencyAdjustment) * 100) / 100, windows, regime, regimeConfidence, anomaly, anomalyScore, anomalyRecovery }] as const;
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

async function latestHaltSnapshot(
  reader:(productId:string,marketplaceId:string,since:string)=>Promise<AutonomousFeedbackSnapshot[]>,
  productId:string, marketplaceId:string, observedAt:string
):Promise<AutonomousFeedbackSnapshot|undefined> {
  const since = new Date(Date.parse(observedAt) - 30 * 24 * 60 * 60 * 1000).toISOString();
  const snapshots = await reader(productId, marketplaceId, since);
  return snapshots
    .filter((snapshot) => snapshot.anomaly === "halt" && Date.parse(snapshot.observedAt) <= Date.parse(observedAt))
    .sort((a,b) => b.observedAt.localeCompare(a.observedAt))[0];
}

async function buildWindows(
  reader:(productId:string,marketplaceId:string,since:string)=>Promise<AutonomousFeedbackSnapshot[]>,
  productId:string, marketplaceId:string, current:OpportunityPerformanceSignal, observedAt:string
):Promise<{ "24h":PerformanceWindow; "7d":PerformanceWindow; "30d":PerformanceWindow }> {
  const now=Date.parse(observedAt);
  const snapshots=await reader(productId,marketplaceId,new Date(now-30*24*60*60*1000).toISOString());
  const make=(ms:number):PerformanceWindow=>{
    const since=new Date(now-ms).getTime();
    const base=[...snapshots].filter(s=>Date.parse(s.observedAt)>=since).sort((a,b)=>a.observedAt.localeCompare(b.observedAt))[0];
    if(!base)return {clickCount:0,conversionCount:0,conversionRate:0,confidence:0};
    const clicks=Math.max(0,current.clickCount-base.clickCount);
    const conversions=Math.max(0,current.conversionCount-base.conversionCount);
    return {clickCount:clicks,conversionCount:conversions,conversionRate:clicks?conversions/clicks:0,confidence:confidenceForClicks(clicks)};
  };
  return {"24h":make(24*60*60*1000),"7d":make(7*24*60*60*1000),"30d":make(30*24*60*60*1000)};
}
function classifyWindowRegime(w:{ "24h":PerformanceWindow;"7d":PerformanceWindow;"30d":PerformanceWindow }):PerformanceRegime {
  const a=w["24h"], b=w["7d"], c=w["30d"];
  const usable=[a,b,c].filter(x=>x.clickCount>=MINIMUM_EVIDENCE_CLICKS);
  if(!usable.length)return "stable";
  const evidence24=a.confidence;
  if(evidence24<0.5)return "stable";
  const short=a.conversionRate, medium=b.conversionRate, long=c.conversionRate;
  const max=Math.max(short,medium,long), min=Math.min(short,medium,long);
  if(max-min>=0.04 && Math.abs(short-long)>=0.04)return short>long ? "rising" : "declining";
  if(a.confidence>=0.75 && b.confidence>=0.75 && Math.abs(short-medium)>=0.05)return short>medium ? "rising" : "declining";
  if(Math.max(short,medium,long)-Math.min(short,medium,long)>=0.06)return "volatile";
  return "stable";
}
function calculateAnomalyScore(w:{ "24h":PerformanceWindow; "7d":PerformanceWindow; "30d":PerformanceWindow }):number {
  const a=w["24h"], b=w["7d"], c=w["30d"];
  if (a.clickCount < MINIMUM_EVIDENCE_CLICKS || b.clickCount < MINIMUM_EVIDENCE_CLICKS || c.clickCount < MINIMUM_EVIDENCE_CLICKS) return 0;
  const rateJump=Math.min(1,Math.abs(a.conversionRate-c.conversionRate)/0.10);
  const evidence=Math.min(1,(a.confidence+b.confidence+c.confidence)/3);
  return Math.round(rateJump*evidence*100)/100;
}
function classifyAnomaly(score:number):PerformanceAnomaly {
  if(score>=0.75)return "halt";
  if(score>=0.45)return "watch";
  return "none";
}
function hasRecoveryEvidence(
  windows:{ "24h":PerformanceWindow; "7d":PerformanceWindow; "30d":PerformanceWindow },
  recoveryClicks:number,
  anomalyScore:number
):boolean {
  if (recoveryClicks < ANOMALY_RECOVERY_CLICKS || anomalyScore >= ANOMALY_RECOVERY_MAX_SCORE) return false;
  const short = windows["24h"];
  const medium = windows["7d"];
  const long = windows["30d"];
  if (short.confidence < ANOMALY_RECOVERY_MIN_CONFIDENCE || medium.confidence < ANOMALY_RECOVERY_MIN_CONFIDENCE) return false;
  if (Math.abs(short.conversionRate - long.conversionRate) > ANOMALY_RECOVERY_MAX_RATE_DIVERGENCE) return false;
  return true;
}


function calculateRegimeConfidence(w:{ "24h":PerformanceWindow; "7d":PerformanceWindow; "30d":PerformanceWindow }, regime:PerformanceRegime):number {
  const short=w["24h"], medium=w["7d"], long=w["30d"];
  const evidence=Math.min(1,(short.confidence*0.5)+(medium.confidence*0.3)+(long.confidence*0.2));
  if(regime==="stable") return evidence;
  const divergence=Math.min(1,Math.abs(short.conversionRate-long.conversionRate)/0.05);
  return Math.min(1,evidence*(0.5+0.5*divergence));
}

function calculateWindowAdjustment(w:{ "24h":PerformanceWindow;"7d":PerformanceWindow;"30d":PerformanceWindow },regime:PerformanceRegime):number {
  const weighted=[["24h",0.5],["7d",0.3],["30d",0.2]] as const;
  let total=0,weight=0;
  for(const [name,wgt] of weighted){const x=w[name];if(x.clickCount<MINIMUM_EVIDENCE_CLICKS)continue;const effective=wgt*x.confidence;total+=((x.conversionRate-BASELINE_CONVERSION_RATE)/BASELINE_CONVERSION_RATE)*effective;weight+=effective;}
  if(!weight)return 0;
  const base=clamp((total/weight)*2,-2,2);
  return regime==="volatile"?base*0.5:base;
}

function confidenceForClicks(clicks: number): number { return Math.min(1, Math.sqrt(Math.max(0, clicks) / MINIMUM_EVIDENCE_CLICKS)); }

function learningFreshness(observedAt: string, nowIso: string): number {
  const observedMs = Date.parse(observedAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs) || nowMs <= observedMs) return 1;
  const ageMs = nowMs - observedMs;
  return Math.max(0, Math.min(1, Math.pow(0.5, ageMs / LEARNING_HALF_LIFE_MS)));
}

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
