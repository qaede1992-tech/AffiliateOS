import type { AffiliateOffer, AudienceSegment, Product, ProductOpportunity } from "@affiliateos/shared";

export type OpportunityScoringInput = {
  product: Product;
  offers: AffiliateOffer[];
  audience?: AudienceSegment[];
  targetPriceMaxCents?: number;
};

export type OpportunityScoreBreakdown = {
  commission: number;
  demand: number;
  audienceFit: number;
  socialProof: number;
  priceAppeal: number;
  availability: number;
  confidencePenalty: number;
  performanceAdjustment?: number;
  total: number;
};

export type ScoredOpportunity = ProductOpportunity & { breakdown: OpportunityScoreBreakdown; offerId?: string };

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const logScore = (value: number, scale: number) => clamp((Math.log10(Math.max(0, value) + 1) / scale) * 100);
const audienceCategories: Record<AudienceSegment, string[]> = { beauty: ["beauty", "makeup", "cosmetic", "skincare"], skincare: ["skincare", "skin", "serum", "moisturizer", "cosmetic"], baby: ["baby", "infant", "newborn", "diaper"], parenting: ["parent", "parenting", "baby", "family"], fashion: ["fashion", "clothing", "apparel", "shoes", "dress"], home: ["home", "decor", "furniture", "storage"], kitchen: ["kitchen", "cook", "cooking", "bake", "utensil"], electronics: ["electronic", "phone", "laptop", "gadget", "computer"], lifestyle: ["lifestyle", "wellness", "fitness", "travel"], "deal-hunters": ["deal", "discount", "sale", "promo", "bundle"] };
function textFor(product: Product): string { return `${product.name} ${product.description ?? ""} ${product.category ?? ""}`.toLowerCase(); }
function audienceFit(product: Product, audience: AudienceSegment[]): { score: number; matched: AudienceSegment[] } { if (audience.length === 0) return { score: 50, matched: [] }; const text = textFor(product); const matched = audience.filter((segment) => audienceCategories[segment].some((term) => text.includes(term))); return { score: clamp((matched.length / audience.length) * 100), matched }; }
function isAffiliateLinkUsable(offer: AffiliateOffer, now = new Date()): boolean { return offer.affiliateLinkStatus === "active" && Boolean(offer.affiliateUrl) && (!offer.affiliateLinkExpiresAt || new Date(offer.affiliateLinkExpiresAt).getTime() > now.getTime()); }
function commissionSignal(offer: AffiliateOffer): number {
  const rateSignal = offer.commissionRateBps === undefined ? undefined : clamp((offer.commissionRateBps / 2_000) * 100);
  const amountSignal = offer.commissionAmountCents !== undefined && offer.priceCents && offer.priceCents > 0
    ? clamp((offer.commissionAmountCents / offer.priceCents) * 2_000)
    : undefined;
  return Math.max(rateSignal ?? 0, amountSignal ?? 0);
}
function bestOffer(productId: string, offers: AffiliateOffer[]): AffiliateOffer | undefined {
  return offers
    .filter((offer) => offer.productId === productId && offer.status === "active" && isAffiliateLinkUsable(offer) && offer.availability !== "out_of_stock")
    .slice()
    .sort((a, b) => {
      const commissionA = commissionSignal(a);
      const commissionB = commissionSignal(b);
      const availabilityA = a.availability === "limited" ? 55 : 100;
      const availabilityB = b.availability === "limited" ? 55 : 100;
      const utilityA = commissionA * 0.25 + availabilityA * 0.15;
      const utilityB = commissionB * 0.25 + availabilityB * 0.15;
      return utilityB - utilityA ||
        (b.commissionRateBps ?? 0) - (a.commissionRateBps ?? 0) ||
        (b.commissionAmountCents ?? 0) - (a.commissionAmountCents ?? 0) ||
        a.id.localeCompare(b.id);
    })[0];
}

export function scoreOpportunity(input: OpportunityScoringInput): ScoredOpportunity {
  const { product } = input;
  if (product.status !== "active") {
    return {
      product,
      offerId: undefined,
      score: 0,
      reasons: ["Product is inactive"],
      disclaimer: "Score is a decision-support signal based on available catalog data; it does not guarantee conversions or profit.",
      breakdown: { commission: 0, demand: 0, audienceFit: 0, socialProof: 0, priceAppeal: 0, availability: 0, confidencePenalty: 0, total: 0 }
    };
  }
  const offer = bestOffer(product.id, input.offers); const audience = audienceFit(product, input.audience ?? []);
  const commission = offer ? commissionSignal(offer) : 0;
  const demand = clamp(logScore(product.soldCount, 5) * 0.7 + logScore(product.reviewCount, 5) * 0.3);
  const socialProof = clamp((product.ratingMilli ?? 0) / 50 * 0.7 + logScore(product.reviewCount, 6) * 0.3);
  const discount = product.originalPriceCents && product.originalPriceCents > product.priceCents ? clamp(((product.originalPriceCents - product.priceCents) / product.originalPriceCents) * 100) : 0;
  const targetPrice = input.targetPriceMaxCents && input.targetPriceMaxCents > 0 ? clamp((1 - product.priceCents / input.targetPriceMaxCents) * 100) : 50;
  const priceAppeal = clamp(discount * 0.6 + targetPrice * 0.4); const availability = offer ? (offer.availability === "limited" ? 55 : 100) : 0;
  const confidencePenalty = audience.score === 50 && (input.audience?.length ?? 0) === 0 ? 8 : 0;
  const total = clamp(commission * 0.25 + demand * 0.20 + audience.score * 0.20 + socialProof * 0.10 + priceAppeal * 0.10 + availability * 0.15 - confidencePenalty);
  const reasons: string[] = []; if (commission >= 60) reasons.push("Strong commission potential"); if (demand >= 60) reasons.push("Strong demand signals from sales and reviews"); if (audience.matched.length) reasons.push(`Matches ${audience.matched.join(", ")} audience intent`); if (priceAppeal >= 60) reasons.push("Competitive price or discount signal"); if (socialProof >= 70) reasons.push("Strong rating and review evidence"); if (!offer) reasons.push("No active affiliate offer available"); if (availability < 100 && availability > 0) reasons.push("Offer availability is limited");
  return { product, offerId: offer?.id, score: Math.round(total * 100) / 100, reasons, disclaimer: "Score is a decision-support signal based on available catalog data; it does not guarantee conversions or profit.", breakdown: { commission: Math.round(commission * 100) / 100, demand: Math.round(demand * 100) / 100, audienceFit: Math.round(audience.score * 100) / 100, socialProof: Math.round(socialProof * 100) / 100, priceAppeal: Math.round(priceAppeal * 100) / 100, availability, confidencePenalty, total: Math.round(total * 100) / 100 } };
}
export function rankOpportunities(inputs: OpportunityScoringInput[]): ScoredOpportunity[] { return inputs.map(scoreOpportunity).sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id)); }
