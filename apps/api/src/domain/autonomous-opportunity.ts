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
  if (item.breakdown.commission * 20 < minimumCommissionRateBps) reasons.push("Commission rate is below the minimum");
  if ((item.breakdown.commissionAmountCents ?? 0) < minimumCommissionAmountCents) reasons.push("Commission amount is below the minimum");
  if (item.breakdown.demand < minimumDemandScore) reasons.push("Demand score is below the minimum");
  return unique(reasons);
};

export class AutonomousOpportunitySelector {
  select(
    candidates: OpportunityCandidateSource[],
    policy: OpportunitySelectionPolicy = {},
    performance: Map<string, OpportunityPerformanceSignal> = new Map(),
    policiesByMarketplace: OpportunitySelectionPoliciesByMarketplace = {}
  ): OpportunitySelectionResult {
    const maximumResults = policy.maximumResults ?? 10;
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
      ...(policiesByMarketplace[candidate.product.marketplaceId] ?? {})
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
      const exact = performance.get(`${item.product.marketplaceId}:${item.product.id}`) ?? performance.get(item.product.id);
      const category = item.product.category?.trim().toLowerCase();
      const categorySignal = category ? performance.get(`${item.product.marketplaceId}:category:${category}`) : undefined;
      const audienceSignals = unique(candidatePolicy.requiredAudience ?? []).map((segment) => performance.get(`${item.product.marketplaceId}:audience:${segment.toLowerCase()}`)).filter((signal): signal is OpportunityPerformanceSignal => Boolean(signal));
      const audienceSignal = audienceSignals.length > 0 ? audienceSignals.reduce((best, signal) => Math.abs(signal.adjustment) > Math.abs(best.adjustment) ? signal : best) : undefined;
      return applyPerformance(item, exact ?? categorySignal ?? audienceSignal);
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
        item.breakdown.commission * 20 >= minimumCommissionRateBps &&
        (item.breakdown.commissionAmountCents ?? 0) >= minimumCommissionAmountCents &&
        item.breakdown.demand >= minimumDemandScore &&
        item.product.status === "active";
    });
    const selected = eligible.slice(0, Math.max(0, maximumResults));
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
      const reasons = selectedIds.has(item.product.id)
        ? ["Selected"]
        : rejectionReasons(item, minimumScore, requiredAudience, minimumCommissionRateBps, minimumCommissionAmountCents, minimumDemandScore);
      return {
        auditId: randomUUID(),
        productId: item.product.id,
        marketplaceId: item.product.marketplaceId,
        selected: selectedIds.has(item.product.id),
        score: item.score,
        policy: { ...candidatePolicy },
        reasons
      };
    });
    return { selected, rejected, audit };
  }
}

function applyPerformance(item: ScoredOpportunity, signal?: OpportunityPerformanceSignal): ScoredOpportunity {
  if (!signal || signal.adjustment === 0) return item;
  const score = Math.round(Math.min(100, Math.max(0, item.score + signal.adjustment)) * 100) / 100;
  const direction = signal.adjustment > 0 ? "positive" : "negative";
  return {
    ...item,
    score,
    reasons: [...item.reasons, `Historical conversion feedback applied (${direction}, ${signal.adjustment} points)`],
    breakdown: { ...item.breakdown, total: score, performanceAdjustment: signal.adjustment }
  };
}
