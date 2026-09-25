import type { AffiliateOffer, AudienceSegment, Product } from "@affiliateos/shared";
import { rankOpportunities, type ScoredOpportunity } from "./opportunity-scoring.js";
import type { OpportunityPerformanceSignal } from "./autonomous-feedback.js";
import { randomUUID } from "node:crypto";

export type OpportunitySelectionPolicy = {
  minimumScore?: number;
  maximumResults?: number;
  requiredAudience?: AudienceSegment[];
  targetPriceMaxCents?: number;
  minimumCommissionRateBps?: number;
  minimumCommissionAmountCents?: number;
  minimumDemandScore?: number;
  explorationRate?: number;
  explorationMinimumEvidenceClicks?: number;
};

export type OpportunitySelectionPoliciesByMarketplace = Record<string, OpportunitySelectionPolicy>;

export type OpportunityCandidateSource = {
  product: Product;
  offers: AffiliateOffer[];
};

export type OpportunitySelectionAudit = {
  auditId: string;
  productId: string;
  marketplaceId: string;
  selected: boolean;
  score: number;
  policy: OpportunitySelectionPolicy;
  reasons: string[];
  selectionMode?: "exploration" | "exploitation";
  category?: string;
  audienceSegments?: AudienceSegment[];
};

export type OpportunitySelectionResult = {
  selected: ScoredOpportunity[];
  rejected: Array<{ productId: string; score: number; reasons: string[] }>;
  audit: OpportunitySelectionAudit[];
};

const unique = <T>(items: T[]): T[] => [...new Set(items)];

const rejectionReasons = (
  item: ScoredOpportunity,
  minimumScore: number,
  requiredAudience: AudienceSegment[],
  minimumCommissionRateBps: number,
  minimumCommissionAmountCents: number,
  minimumDemandScore: number
): string[] => {
  const reasons = [...item.reasons];
  if (item.product.status !== "active") reasons.push("Product is not active");
  if (item.score < minimumScore) reasons.push(`Score ${item.score} is below minimum ${minimumScore}`);
  if (!item.offerId) reasons.push("No eligible affiliate offer");
  if (requiredAudience.length > 0 && item.breakdown.audienceFit <= 0) reasons.push("Does not match the required audience");
  if (item.breakdown.commissionRateBps < minimumCommissionRateBps) reasons.push("Commission rate is below the minimum");
  if ((item.breakdown.commissionAmountCents ?? 0) < minimumCommissionAmountCents) reasons.push("Commission amount is below the minimum");
  if (item.breakdown.demand < minimumDemandScore) reasons.push("Demand score is below the minimum");
  return unique(reasons);
};

export class AutonomousOpportunitySelector {
  select(
    candidates: OpportunityCandidateSource[],
    policy: OpportunitySelectionPolicy = {},
    performanceOrPolicies: Map<string, OpportunityPerformanceSignal> | OpportunitySelectionPoliciesByMarketplace = new Map(),
    policiesByMarketplace: OpportunitySelectionPoliciesByMarketplace = {},
    adaptiveExplorationRates: Map<string, number> = new Map()
  ): OpportunitySelectionResult {
    const performance = performanceOrPolicies instanceof Map ? performanceOrPolicies : new Map<string, OpportunityPerformanceSignal>();
    const effectivePoliciesByMarketplace = performanceOrPolicies instanceof Map ? policiesByMarketplace : performanceOrPolicies;
    const mergedCandidates = new Map<string, OpportunityCandidateSource>();
    for (const candidate of candidates) {
      const existing = mergedCandidates.get(candidate.product.id);
      if (!existing) {
        mergedCandidates.set(candidate.product.id, {
          product: candidate.product,
          offers: [...candidate.offers]
        });
      } else {
        const offers = new Map(existing.offers.map((offer) => [offer.id, offer]));
        for (const offer of candidate.offers) offers.set(offer.id, offer);
        existing.offers = [...offers.values()];
      }
    }
    const effectivePolicy = (candidate: OpportunityCandidateSource): OpportunitySelectionPolicy => ({
      ...policy,
      ...(effectivePoliciesByMarketplace[candidate.product.marketplaceId] ?? {})
    });
    const scored = [...mergedCandidates.values()].map((candidate) => {
      const candidatePolicy = effectivePolicy(candidate);
      return {
        product: candidate.product,
        offers: candidate.offers,
        audience: unique(candidatePolicy.requiredAudience ?? []),
        targetPriceMaxCents: candidatePolicy.targetPriceMaxCents
      };
    });

    const adjusted = rankOpportunities(scored).map((item) => {
      const candidatePolicy = effectivePolicy({ product: item.product, offers: [] });
      const exact = performance.get(item.product.marketplaceId + ":" + item.product.id) ?? performance.get(item.product.id);
      const category = item.product.category?.trim().toLowerCase();
      const categorySignal = category ? performance.get(item.product.marketplaceId + ":category:" + category) : undefined;
      const globalCategorySignal = category ? performance.get("global:category:" + category) : undefined;
      const globalAudienceSignals = unique(candidatePolicy.requiredAudience ?? [])
        .map((segment) => performance.get("global:audience:" + segment.toLowerCase()))
        .filter((signal): signal is OpportunityPerformanceSignal => Boolean(signal));
      const audienceSignals = unique(candidatePolicy.requiredAudience ?? [])
        .map((segment) => performance.get(item.product.marketplaceId + ":audience:" + segment.toLowerCase()))
        .filter((signal): signal is OpportunityPerformanceSignal => Boolean(signal));
      return applyPerformance(item, composePerformance(exact, categorySignal, audienceSignals, globalCategorySignal, globalAudienceSignals));
    });
    const ranked = adjusted.sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id));

    const eligible = ranked.filter((item) => {
      const candidatePolicy = effectivePolicy({ product: item.product, offers: [] });
      const minimumScore = candidatePolicy.minimumScore ?? 60;
      const requiredAudience = unique(candidatePolicy.requiredAudience ?? []);
      const minimumCommissionRateBps = Math.max(0, candidatePolicy.minimumCommissionRateBps ?? 0);
      const minimumCommissionAmountCents = Math.max(0, candidatePolicy.minimumCommissionAmountCents ?? 0);
      const minimumDemandScore = Math.max(0, Math.min(100, candidatePolicy.minimumDemandScore ?? 0));
      return item.score >= minimumScore && Boolean(item.offerId) &&
        (requiredAudience.length === 0 || item.breakdown.audienceFit > 0) &&
        item.breakdown.commissionRateBps >= minimumCommissionRateBps &&
        (item.breakdown.commissionAmountCents ?? 0) >= minimumCommissionAmountCents &&
        item.breakdown.demand >= minimumDemandScore &&
        item.product.status === "active";
    });

    const explicitGlobalLimit = policy.maximumResults;
    const selected = selectByMarketplace(
      eligible,
      explicitGlobalLimit,
      performance,
      effectivePolicy,
      adaptiveExplorationRates
    );
    const selectedIds = new Set(selected.map((item) => item.product.id));
    const rejected = ranked.filter((item) => !selectedIds.has(item.product.id)).map((item) => {
      const candidatePolicy = effectivePolicy({ product: item.product, offers: [] });
      const minimumScore = candidatePolicy.minimumScore ?? 60;
      const requiredAudience = unique(candidatePolicy.requiredAudience ?? []);
      const minimumCommissionRateBps = Math.max(0, candidatePolicy.minimumCommissionRateBps ?? 0);
      const minimumCommissionAmountCents = Math.max(0, candidatePolicy.minimumCommissionAmountCents ?? 0);
      const minimumDemandScore = Math.max(0, Math.min(100, candidatePolicy.minimumDemandScore ?? 0));
      return {
        productId: item.product.id,
        score: item.score,
        reasons: selected.length < eligible.length && eligible.some((candidate) => candidate.product.id === item.product.id)
          ? ["Selection limit reached"]
          : rejectionReasons(item, minimumScore, requiredAudience, minimumCommissionRateBps, minimumCommissionAmountCents, minimumDemandScore)
      };
    });
    const audit = ranked.map((item) => {
      const candidatePolicy = effectivePolicy({ product: item.product, offers: [] });
      const minimumScore = candidatePolicy.minimumScore ?? 60;
      const requiredAudience = unique(candidatePolicy.requiredAudience ?? []);
      const minimumCommissionRateBps = Math.max(0, candidatePolicy.minimumCommissionRateBps ?? 0);
      const minimumCommissionAmountCents = Math.max(0, candidatePolicy.minimumCommissionAmountCents ?? 0);
      const minimumDemandScore = Math.max(0, Math.min(100, candidatePolicy.minimumDemandScore ?? 0));
      const exploration = selectedIds.has(item.product.id) && isExplorationSelection(item, performance, candidatePolicy, adaptiveExplorationRates);
      const selectionMode: OpportunitySelectionAudit["selectionMode"] = selectedIds.has(item.product.id) ? (exploration ? "exploration" : "exploitation") : undefined;
      const reasons = selectedIds.has(item.product.id)
        ? [exploration ? "Selected for controlled exploration" : "Selected"]
        : rejectionReasons(item, minimumScore, requiredAudience, minimumCommissionRateBps, minimumCommissionAmountCents, minimumDemandScore);
      return {
        auditId: randomUUID(),
        productId: item.product.id,
        marketplaceId: item.product.marketplaceId,
        selected: selectedIds.has(item.product.id),
        score: item.score,
        policy: { ...candidatePolicy },
        reasons,
        selectionMode,
        category: item.product.category?.trim() || undefined,
        audienceSegments: requiredAudience.length ? requiredAudience : undefined
      };
    });
    return { selected, rejected, audit };
  }
}

function isExplorationSelection(item: ScoredOpportunity, performance: Map<string, OpportunityPerformanceSignal>, policy: OpportunitySelectionPolicy, adaptiveExplorationRates: Map<string, number>): boolean {
  const signal = performance.get(item.product.marketplaceId + ":" + item.product.id) ?? performance.get(item.product.id);
  const rate = adaptiveExplorationRates.get(item.product.id) ?? policy.explorationRate ?? 0.2;
  return rate > 0 && (!signal || signal.clickCount < (policy.explorationMinimumEvidenceClicks ?? 20));
}

function selectByMarketplace(
  eligible: ScoredOpportunity[],
  globalLimit: number | undefined,
  performance: Map<string, OpportunityPerformanceSignal>,
  effectivePolicy: (candidate: OpportunityCandidateSource) => OpportunitySelectionPolicy,
  adaptiveExplorationRates: Map<string, number>
): ScoredOpportunity[] {
  if (eligible.length === 0) return [];
  const byMarketplace = new Map<string, ScoredOpportunity[]>();
  for (const item of eligible) {
    const group = byMarketplace.get(item.product.marketplaceId) ?? [];
    group.push(item);
    byMarketplace.set(item.product.marketplaceId, group);
  }
  const selections: ScoredOpportunity[] = [];
  for (const items of byMarketplace.values()) {
    const first = items[0];
    if (!first) continue;
    const marketplaceLimit = effectivePolicy({ product: first.product, offers: [] }).maximumResults;
    const limit = marketplaceLimit === undefined ? 10 : Math.max(0, marketplaceLimit);
    selections.push(...selectWithExploration(items, limit, performance, effectivePolicy, adaptiveExplorationRates));
  }
  const rankedSelections = selections.sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id));
  return globalLimit === undefined
    ? rankedSelections
    : rankedSelections.slice(0, Math.max(0, globalLimit));
}

function selectWithExploration(
  eligible: ScoredOpportunity[],
  maximumResults: number,
  performance: Map<string, OpportunityPerformanceSignal>,
  effectivePolicy: (candidate: OpportunityCandidateSource) => OpportunitySelectionPolicy,
  adaptiveExplorationRates: Map<string, number>
): ScoredOpportunity[] {
  const limit = Math.max(0, maximumResults);
  if (limit === 0 || eligible.length <= limit) return eligible.slice(0, limit);
  const explorationSlots = Math.min(limit, Math.max(0, Math.floor(eligible.reduce((sum, item) => {
    const policy = effectivePolicy({ product: item.product, offers: [] });
    return sum + Math.min(1, Math.max(0, adaptiveExplorationRates.get(item.product.id) ?? policy.explorationRate ?? 0.2));
  }, 0) / Math.max(1, eligible.length) * limit)));
  if (explorationSlots === 0) return eligible.slice(0, limit);
  const exploratory = eligible.filter((item) => {
    const policy = effectivePolicy({ product: item.product, offers: [] });
    const minimumEvidence = Math.max(0, policy.explorationMinimumEvidenceClicks ?? 20);
    const signal = performance.get(item.product.marketplaceId + ":" + item.product.id) ?? performance.get(item.product.id);
    return !signal || signal.clickCount < minimumEvidence;
  });
  if (!exploratory.length) return eligible.slice(0, limit);
  const exploration = exploratory
    .slice()
    .sort((a, b) => a.product.id.localeCompare(b.product.id))
    .slice(0, explorationSlots);
  const explorationIds = new Set(exploration.map((item) => item.product.id));
  return [...exploration, ...eligible.filter((item) => !explorationIds.has(item.product.id))].slice(0, limit);
}

function composePerformance(exact: OpportunityPerformanceSignal | undefined, category: OpportunityPerformanceSignal | undefined, audience: OpportunityPerformanceSignal[], globalCategory?: OpportunityPerformanceSignal, globalAudience: OpportunityPerformanceSignal[] = []): OpportunityPerformanceSignal | undefined {
  const weighted: Array<[OpportunityPerformanceSignal, number]> = [];
  if (exact) weighted.push([exact, 0.5]);
  if (category) weighted.push([category, 0.3]);
  if (audience.length) weighted.push([audience.reduce((best, signal) => Math.abs(signal.adjustment) > Math.abs(best.adjustment) ? signal : best), 0.2]);
  if (globalCategory && (!category || (category.confidence ?? 0) < 0.35)) weighted.push([globalCategory, 0.1 * (1 - (category?.confidence ?? 0))]);
  if (globalAudience.length && !audience.length) weighted.push([globalAudience.reduce((best, signal) => Math.abs(signal.adjustment) > Math.abs(best.adjustment) ? signal : best), 0.1]);
  if (!weighted.length) return undefined;
  const primary = weighted[0];
  if (!primary) return undefined;
  const totalWeight = weighted.reduce((sum, [signal, weight]) => sum + weight * Math.max(0.1, signal.confidence ?? 0.25), 0);
  const adjustment = weighted.reduce((sum, [signal, weight]) => sum + signal.adjustment * weight * Math.max(0.1, signal.confidence ?? 0.25), 0) / totalWeight;
  const evidence = weighted.reduce((sum, [signal, weight]) => sum + signal.clickCount * weight * Math.max(0.1, signal.confidence ?? 0.25), 0) / totalWeight;
  const confidence = Math.min(1, weighted.reduce((sum, [signal, weight]) => sum + (signal.confidence ?? 0.25) * weight, 0) / weighted.reduce((sum, [, weight]) => sum + weight, 0));
  return { ...primary[0], clickCount: evidence, confidence, adjustment: Math.round(Math.max(-8, Math.min(8, adjustment)) * 100) / 100 };
}

export function applyPerformance(item: ScoredOpportunity, signal?: OpportunityPerformanceSignal): ScoredOpportunity {
  if (!signal || signal.adjustment === 0) return item;
  const regimeConfidence = signal.regimeConfidence ?? 1;
  const recoveryMultiplier = signal.anomalyRecovery === "recovering"
    ? 0.25
    : signal.anomalyRecovery === "recovered"
      ? 0.5 + 0.5 * Math.max(0, Math.min(1, signal.recoveryEvidenceScore ?? 0))
      : 1;
  const recoveryQualityMultiplier = signal.anomalyRecovery === "recovered" && signal.recoveryEpisodeMetrics
    && (signal.recoveryEpisodeMetrics.conversionDelta < 0 || signal.recoveryEpisodeMetrics.commissionDeltaCents < 0) ? 0.5 : 1;
  const guardedAdjustment = (signal.regime === "volatile" ? signal.adjustment * Math.min(0.5, regimeConfidence) : signal.adjustment * regimeConfidence) * recoveryMultiplier * recoveryQualityMultiplier;
  const score = Math.round(Math.min(100, Math.max(0, item.score + guardedAdjustment)) * 100) / 100;
  const direction = guardedAdjustment > 0 ? "positive" : "negative";
  return {
    ...item,
    score,
    reasons: [...(item.reasons ?? []), `Historical conversion feedback applied (${direction}, ${guardedAdjustment} points)`, ...(signal.anomalyRecovery === "recovering" ? ["Anomaly recovery in progress; performance influence is heavily damped."] : [])],
    breakdown: { ...item.breakdown, total: score, performanceAdjustment: guardedAdjustment }
  };
}
