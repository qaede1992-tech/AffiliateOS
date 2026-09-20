import type { AffiliateOffer, AudienceSegment, Product } from "@affiliateos/shared";
import { rankOpportunities, type ScoredOpportunity } from "./opportunity-scoring.js";

export type OpportunitySelectionPolicy = {
  minimumScore?: number;
  maximumResults?: number;
  requiredAudience?: AudienceSegment[];
  targetPriceMaxCents?: number;
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
  requiredAudience: AudienceSegment[]
): string[] => {
  const reasons = [...item.reasons];
  if (item.product.status !== "active") reasons.push("Product is not active");
  if (item.score < minimumScore) reasons.push(`Score ${item.score} is below minimum ${minimumScore}`);
  if (!item.offerId) reasons.push("No eligible affiliate offer");
  if (requiredAudience.length > 0 && item.breakdown.audienceFit <= 0) {
    reasons.push("Does not match the required audience");
  }
  return unique(reasons);
};

export class AutonomousOpportunitySelector {
  select(
    candidates: OpportunityCandidateSource[],
    policy: OpportunitySelectionPolicy = {}
  ): OpportunitySelectionResult {
    const minimumScore = policy.minimumScore ?? 60;
    const maximumResults = policy.maximumResults ?? 10;
    const requiredAudience = unique(policy.requiredAudience ?? []);
    const scored = rankOpportunities(candidates.map((candidate) => ({
      product: candidate.product,
      offers: candidate.offers,
      audience: requiredAudience,
      targetPriceMaxCents: policy.targetPriceMaxCents
    })));

    const eligible = scored.filter((item) => {
      if (item.score < minimumScore) return false;
      if (!item.offerId) return false;
      if (requiredAudience.length > 0 && item.breakdown.audienceFit <= 0) return false;
      return item.product.status === "active";
    });

    const selected = eligible.slice(0, Math.max(0, maximumResults));
    const selectedIds = new Set(selected.map((item) => item.product.id));
    const rejected = scored
      .filter((item) => !selectedIds.has(item.product.id))
      .map((item) => ({
        productId: item.product.id,
        score: item.score,
        reasons: selected.length < eligible.length && eligible.some((candidate) => candidate.product.id === item.product.id)
          ? ["Selection limit reached"]
          : rejectionReasons(item, minimumScore, requiredAudience)
      }));

    return { selected, rejected };
  }
}
