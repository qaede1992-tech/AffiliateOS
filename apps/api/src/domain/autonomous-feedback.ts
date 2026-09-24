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
  recoveryClicks?: number;
  recoveryEvidenceScore?: number;
  recoveryEpisodeId?: string;
  recoveryEpisodeMetrics?: RecoveryEpisodeMetrics;
  recoveryPolicy?: { explorationFloor: number; direction: "hold-exploration" | "reduce-exploration" | "neutral"; qualityDelta?: number };
};

export type RecoveryEpisodeMetrics = { recoveryDurationMs: number; recoveryClicks: number; conversionDelta: number; commissionDeltaCents: number; qualityScore?: number; previousEpisodeQualityScore?: number; qualityDelta?: number; };

function calculateRecoveryQuality(metrics: RecoveryEpisodeMetrics): number {
  const conversionQuality = metrics.conversionDelta >= ANOMALY_RECOVERY_MIN_CONVERSION_DELTA ? 1 : 0.5;
  const commissionQuality = metrics.commissionDeltaCents >= ANOMALY_RECOVERY_MIN_COMMISSION_DELTA_CENTS ? 1 : 0.5;
  const clickQuality = Math.min(1, metrics.recoveryClicks / ANOMALY_RECOVERY_CLICKS);
  const durationQuality = metrics.recoveryDurationMs <= 7 * 24 * 60 * 60 * 1000 ? 1 : 0.75;
  return clamp(
    0.25 * conversionQuality + 0.25 * commissionQuality + 0.25 * clickQuality + 0.25 * durationQuality,
    0.5,
    1
  );
}

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
const ANOMALY_RECOVERY_STABILITY_SNAPSHOTS = 3;
const ANOMALY_RECOVERY_MIN_CONVERSION_DELTA = 0;
const ANOMALY_RECOVERY_MIN_COMMISSION_DELTA_CENTS = 0;
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
      const regime = windows ? classifyWindowRegime(windows, signal.conversionRate) : "stable";
      const regimeConfidence = windows ? calculateRegimeConfidence(windows, regime) : 0;
      const anomalyScore = windows ? calculateAnomalyScore(windows) : 0;
      const elapsedSincePrevious = previous ? Date.parse(observedAt) - Date.parse(previous.observedAt) : Number.POSITIVE_INFINITY;
      const recentHalt = previous?.anomaly === "halt" && elapsedSincePrevious < ANOMALY_COOLDOWN_MS;
      const recoveryAnchor = isProductSignal && this.memory!.recentByProductAndMarketplace
        ? (await activeRecoveryEpisode(this.memory!.recentByProductAndMarketplace.bind(this.memory!), productId, marketplaceId!, observedAt)
          ?? (previous?.anomaly === "halt" ? previous : undefined))
        : undefined;
      const recoveryClicks = recoveryAnchor ? Math.max(0, signal.clickCount - recoveryAnchor.clickCount) : ANOMALY_RECOVERY_CLICKS;
      const recoveryEvidenceScore = windows
        ? calculateRecoveryEvidenceScore(windows, recoveryClicks, anomalyScore)
        : recoveryClicks >= ANOMALY_RECOVERY_CLICKS ? 1 : 0;
      const recoveryEvidence = recoveryEvidenceScore >= 0.75;
      const recoveryGate = Boolean(recoveryAnchor) && elapsedSincePrevious >= ANOMALY_COOLDOWN_MS && !recoveryEvidence;
      const classifiedAnomaly = classifyAnomaly(anomalyScore);
      const anomaly = recentHalt || recoveryGate ? "halt" : classifiedAnomaly;
      const stableRecovery = recoveryAnchor && recoveryEvidence
        ? await hasStableRecoveryWindow(this.memory!.recentByProductAndMarketplace!.bind(this.memory!), productId, marketplaceId!, recoveryAnchor.observedAt, observedAt)
        : false;
      const anomalyRecovery: AnomalyRecoveryState = recoveryAnchor
        ? (recentHalt || recoveryGate
          ? "recovering"
          : previous?.recoveryState === "recovered" && anomaly !== "halt"
            ? "recovered"
            : stableRecovery ? "recovered" : "recovering")
        : "none";
      const recoveryEpisodeId = recoveryAnchor ? recoveryAnchor.id : undefined;
      const recoveryEpisodeMetrics = recoveryAnchor ? {
        recoveryDurationMs: Math.max(0, Date.parse(observedAt) - Date.parse(recoveryAnchor.observedAt)),
        recoveryClicks,
        conversionDelta: signal.conversionCount - recoveryAnchor.conversionCount,
        commissionDeltaCents: signal.attributedCommissionCents - recoveryAnchor.attributedCommissionCents
      } : undefined;
      const recoveryQuality = recoveryAnchor ? calculateRecoveryQuality(recoveryEpisodeMetrics!) : 1;
      if (recoveryEpisodeMetrics) recoveryEpisodeMetrics.qualityScore = recoveryQuality;
      const previousEpisode = recoveryAnchor && this.memory!.previousRecoveryEpisodeAnalytics
        ? await this.memory!.previousRecoveryEpisodeAnalytics(productId, marketplaceId!, recoveryAnchor.id)
        : undefined;
      if (recoveryEpisodeMetrics && previousEpisode) { recoveryEpisodeMetrics.previousEpisodeQualityScore = previousEpisode.closingQualityScore ?? previousEpisode.averageQualityScore; recoveryEpisodeMetrics.qualityDelta = (recoveryEpisodeMetrics.qualityScore ?? 0) - recoveryEpisodeMetrics.previousEpisodeQualityScore; }
      const qualityDelta = recoveryEpisodeMetrics?.qualityDelta;
      const recoveryPolicy = {
        explorationFloor: qualityDelta !== undefined && qualityDelta < -0.15 ? 0.35 : 0,
        direction: qualityDelta !== undefined && qualityDelta < -0.15 ? "hold-exploration" as const : qualityDelta !== undefined && qualityDelta > 0.15 ? "reduce-exploration" as const : "neutral" as const,
        qualityDelta
      };
      const recoveryConfidence = anomalyRecovery === "recovered"
        ? recoveryConfidenceMultiplier(recoveryEvidenceScore) * recoveryQuality
        : 1;
      const windowAdjustment = windows && anomaly !== "halt"
        ? calculateWindowAdjustment(windows, regime) * regimeConfidence * recoveryConfidence * (anomaly === "watch" ? 0.35 : 1)
        : 0;
      const adjustment = anomaly === "halt"
        ? 0
        : Math.round(clamp(signal.adjustment + trendAdjustment + efficiencyAdjustment + windowAdjustment, -MAX_ADJUSTMENT, MAX_ADJUSTMENT) * 100) / 100;
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
        recoveryState: recoveryAnchor ? (recentHalt || recoveryGate ? "recovering" : "recovered") : "none",
        recoveryClicks,
        recoveryEvidenceScore,
        recoveryQualityScore: recoveryEpisodeMetrics?.qualityScore ?? 0,
        recoveryEpisodeId,
        observedAt
      };
      if (this.memory!.saveIfAbsent) await this.memory!.saveIfAbsent(snapshot);
      else await this.memory!.save(snapshot);
      return [key, { ...signal, adjustment, trendAdjustment: Math.round((trendAdjustment + efficiencyAdjustment) * 100) / 100, windows, regime, regimeConfidence, anomaly, anomalyScore, anomalyRecovery, recoveryClicks, recoveryEvidenceScore, recoveryEpisodeId, recoveryEpisodeMetrics, recoveryPolicy }] as const;
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

async function hasStableRecoveryWindow(
  reader:(productId:string,marketplaceId:string,since:string)=>Promise<AutonomousFeedbackSnapshot[]>,
  productId:string, marketplaceId:string, haltObservedAt:string, observedAt:string
):Promise<boolean> {
  const snapshots = await reader(productId, marketplaceId, haltObservedAt);
  const eligible = snapshots
    .filter((snapshot) => Date.parse(snapshot.observedAt) > Date.parse(haltObservedAt) && Date.parse(snapshot.observedAt) <= Date.parse(observedAt))
    .sort((a,b) => a.observedAt.localeCompare(b.observedAt));
  if (eligible.length < ANOMALY_RECOVERY_STABILITY_SNAPSHOTS) return false;
  const recent = eligible.slice(-ANOMALY_RECOVERY_STABILITY_SNAPSHOTS);
  return recent.every((snapshot) => snapshot.recoveryEvidenceScore >= 0.75 && snapshot.anomaly !== "halt");
}

async function activeRecoveryEpisode(
  reader:(productId:string,marketplaceId:string,since:string)=>Promise<AutonomousFeedbackSnapshot[]>,
  productId:string, marketplaceId:string, observedAt:string
):Promise<AutonomousFeedbackSnapshot|undefined> {
  const since = new Date(Date.parse(observedAt) - 30 * 24 * 60 * 60 * 1000).toISOString();
  const snapshots = await reader(productId, marketplaceId, since);
  const ordered = snapshots
    .filter((snapshot) => Date.parse(snapshot.observedAt) <= Date.parse(observedAt))
    .sort((a,b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id));
  const haltIndex = ordered.map((snapshot) => snapshot.anomaly).lastIndexOf("halt");
  if (haltIndex < 0) return undefined;
  const halt = ordered[haltIndex];
  const closed = ordered.slice(haltIndex + 1).some((snapshot) =>
    snapshot.recoveryState === "recovered" &&
    (snapshot.recoveryEpisodeId === halt.id || snapshot.recoveryEpisodeId === undefined)
  );
  return closed ? undefined : halt;
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
function classifyWindowRegime(w:{ "24h":PerformanceWindow;"7d":PerformanceWindow;"30d":PerformanceWindow }, currentRate?: number):PerformanceRegime {
  const a=w["24h"], b=w["7d"], c=w["30d"];
  const usable=[a,b,c].filter(x=>x.clickCount>=MINIMUM_EVIDENCE_CLICKS);
  if(!usable.length)return "stable";
  const evidence24=a.confidence;
  if(evidence24<0.5)return "stable";
  const short=a.conversionRate, medium=b.conversionRate, long=c.conversionRate;
  const max=Math.max(short,medium,long), min=Math.min(short,medium,long);
  if (currentRate !== undefined && a.confidence >= 0.75 && short - currentRate >= 0.05) return "rising";
  if (currentRate !== undefined && a.confidence >= 0.75 && currentRate - short >= 0.05) return "declining";
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
function calculateRecoveryEvidenceScore(
  windows:{ "24h":PerformanceWindow; "7d":PerformanceWindow; "30d":PerformanceWindow },
  recoveryClicks:number,
  anomalyScore:number
):number {
  const clickEvidence = Math.min(1, recoveryClicks / ANOMALY_RECOVERY_CLICKS);
  const anomalyEvidence = anomalyScore >= ANOMALY_RECOVERY_MAX_SCORE ? 0 : 1 - (anomalyScore / ANOMALY_RECOVERY_MAX_SCORE);
  const short = windows["24h"], medium = windows["7d"], long = windows["30d"];
  const confidenceEvidence = Math.min(1, short.confidence, medium.confidence);
  const divergence = Math.abs(short.conversionRate - long.conversionRate);
  const stabilityEvidence = Math.max(0, 1 - (divergence / ANOMALY_RECOVERY_MAX_RATE_DIVERGENCE));
  return Math.round((clickEvidence * 0.25 + anomalyEvidence * 0.25 + confidenceEvidence * 0.25 + stabilityEvidence * 0.25) * 100) / 100;
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

function recoveryConfidenceMultiplier(evidenceScore: number): number {
  // Recovered evidence earns influence gradually: 0.5 at the recovery threshold,
  // rising to 1.0 only when recovery evidence is fully stable.
  return 0.5 + 0.5 * Math.max(0, Math.min(1, evidenceScore));
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
