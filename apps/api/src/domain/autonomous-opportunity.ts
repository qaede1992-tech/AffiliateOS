import type { AffiliateOffer, AudienceSegment, Product } from "@affiliateos/shared";
import { rankOpportunities, type ScoredOpportunity } from "./opportunity-scoring.js";
import type { OpportunityPerformanceSignal } from "./autonomous-feedback.js";

export type OpportunitySelectionPolicy = {
  minimumScore?: number;
  maximumResults?: number;
  requiredAudience?: AudienceSegment[];
  targetPriceMaxCents?: number;
  minimumCommissionRateBps?: number;
  minimumDemandScore?: number;
};

export type OpportunityCandidateSource = {
  product: Product;
  offers: AffiliateOffer[];
};

export type OpportunitySelectionResult = {
  selected: ScoredOpportunity[];
  rejected: Array<{ productId: string; score: number; reasons: string[] }>;
};

const unique = <T>(items: T[]): T[] => [...new Set(items)];

const rejectionReasons = (
  item: ScoredOpportunity,
  minimumScore: number,
  requiredAudience: AudienceSegment[],
  minimumCommissionRateBps: number,
  minimumDemandScore: number
): string[] => {
  const reasons = [...item.reasons];
  if (item.product.status !== "active") reasons.push("Product is not active");
  if (item.score < minimumScore) reasons.push(`Score ${item.score} is below minimum ${minimumScore}`);
  if (!item.offerId) reasons.push("No eligible affiliate offer");
  if (requiredAudience.length > 0 && item.breakdown.audienceFit <= 0) reasons.push("Does not match the required audience");
  if ((item.offerId ? 1 : 0) && (item.breakdown.commission * 2_000) < minimumCommissionRateBps) reasons.push(`Commission rate is below minimum ${minimumCommissionRateBps} bps`);
  if (item.breakdown.demand < minimumDemandScore) reasons.push(`Demand score ${item.breakdown.demand} is below minimum ${minimumDemandScore}`);
  return unique(reasons);
};

export class AutonomousOpportunitySelector {
  select(
    candidates: OpportunityCandidateSource[],
    policy: OpportunitySelectionPolicy = {},
    performance: Map<string, OpportunityPerformanceSignal> = new Map()
  ): OpportunitySelectionResult {
    const minimumScore = policy.minimumScore ?? 60;
    const maximumResults = policy.maximumResults ?? 10;
    const requiredAudience = unique(policy.requiredAudience ?? []);
    const minimumCommissionRateBps = Math.max(0, policy.minimumCommissionRateBps ?? 0);
    const minimumDemandScore = Math.max(0, Math.min(100, policy.minimumDemandScore ?? 0));
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
    const scored = [...mergedCandidates.values()].map((candidate) => ({
      product: candidate.product,
      offers: candidate.offers,
      audience: requiredAudience,
      targetPriceMaxCents: policy.targetPriceMaxCents
    }));

    const adjusted = rankOpportunities(scored).map((item) => applyPerformance(item, performance.get(item.product.id)));
    const ranked = adjusted.sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id));

    const eligible = ranked.filter((item) => item.score >= minimumScore && Boolean(item.offerId) &&
      (requiredAudience.length === 0 || item.breakdown.audienceFit > 0) &&
      item.breakdown.commission * 2_000 >= minimumCommissionRateBps &&
      item.breakdown.demand >= minimumDemandScore &&
      item.product.status === "active");
    const selected = eligible.slice(0, Math.max(0, maximumResults));
    const selectedIds = new Set(selected.map((item) => item.product.id));
    const rejected = ranked.filter((item) => !selectedIds.has(item.product.id)).map((item) => ({
      productId: item.product.id,
      score: item.score,
      reasons: selected.length < eligible.length && eligible.some((candidate) => candidate.product.id === item.product.id)
        ? ["Selection limit reached"]
        : rejectionReasons(item, minimumScore, requiredAudience, minimumCommissionRateBps, minimumDemandScore)
    }));
    return { selected, rejected };
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
