import type { AffiliateOffer, AudienceSegment, Product, ProductOpportunity, ProductMetricQuality } from "@affiliateos/shared";

export type OpportunityScoringInput = {
  product: Product;
  offers: AffiliateOffer[];
  audience?: AudienceSegment[];
  targetPriceMaxCents?: number;
  /** 0-100 readiness from current, rights-verified, persisted product media. */
  mediaReadinessScore?: number;
};

export type OpportunityScoreBreakdown = {
  commission: number;
  commissionRateBps: number;
  commissionAmountCents: number;
  demand: number;
  demandEvidenceAvailable: boolean;
  audienceFit: number;
  socialProof: number;
  priceAppeal: number;
  availability: number;
  mediaReadiness?: number;
  /** Percentage of the fixed scoring model supported by observed data. */
  dataConfidence: number;
  confidencePenalty: number;
  performanceAdjustment?: number;
  total: number;
};

export type ScoredOpportunity = ProductOpportunity & { breakdown: OpportunityScoreBreakdown; offerId?: string };

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const logScore = (value: number, scale: number) => {
  const numeric = Number.isFinite(value) ? Math.max(0, value) : 0;
  return clamp((Math.log10(numeric + 1) / scale) * 100);
};
const DISCOVERY_SIGNAL_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const audienceCategories: Record<AudienceSegment, string[]> = { beauty: ["beauty", "makeup", "cosmetic", "skincare"], skincare: ["skincare", "skin", "serum", "moisturizer", "cosmetic"], baby: ["baby", "infant", "newborn", "diaper"], parenting: ["parent", "parenting", "baby", "family"], fashion: ["fashion", "clothing", "apparel", "shoes", "dress"], home: ["home", "decor", "furniture", "storage"], kitchen: ["kitchen", "cook", "cooking", "bake", "utensil"], electronics: ["electronic", "phone", "laptop", "gadget", "computer"], lifestyle: ["lifestyle", "wellness", "fitness", "travel"], "deal-hunters": ["deal", "discount", "sale", "promo", "bundle"] };
const WEIGHTS = { commission: 22.5, demand: 18, audienceFit: 18, socialProof: 9, priceAppeal: 9, availability: 13.5, mediaReadiness: 10 } as const;
/** Maximum score lift from the neutral media baseline (50) to fully ready (100). */
export const MEDIA_READINESS_MAX_SCORE_LIFT = WEIGHTS.mediaReadiness * 0.5;
/** Maximum data-confidence lift when the media-readiness evidence becomes available. */
export const MEDIA_READINESS_MAX_CONFIDENCE_LIFT = WEIGHTS.mediaReadiness;
type Evidence = { score: number; confidence: number };
function weightedAverage(parts: Array<{ score: number; weight: number; confidence?: number }>): Evidence | undefined {
  const available = parts.filter((part) => Number.isFinite(part.score) && part.weight > 0);
  const weight = available.reduce((sum, part) => sum + part.weight, 0);
  if (weight === 0) return undefined;
  return {
    score: clamp(available.reduce((sum, part) => sum + part.score * part.weight, 0) / weight),
    confidence: clamp(available.reduce((sum, part) => sum + part.weight * (part.confidence ?? 1), 0) / 100)
  };
}
function metricConfidence(value: number | undefined, quality: ProductMetricQuality | undefined): number {
  if (quality === "missing") return 0;
  if (quality === "exact") return 1;
  if (quality === "lower_bound") return 0.75;
  return value !== undefined && value > 0 ? 0.8 : 0;
}
function metricKnown(value: number | undefined, quality: ProductMetricQuality | undefined): value is number {
  return metricConfidence(value, quality) > 0 && value !== undefined;
}
function textFor(product: Product): string { return `${product.name} ${product.description ?? ""} ${product.category ?? ""}`.toLowerCase(); }
function audienceFit(product: Product, audience: AudienceSegment[]): { score: number; matched: AudienceSegment[] } { if (audience.length === 0) return { score: 50, matched: [] }; const text = textFor(product); const matched = audience.filter((segment) => audienceCategories[segment].some((term) => text.includes(term))); return { score: clamp((matched.length / audience.length) * 100), matched }; }
function isAffiliateLinkUsable(offer: AffiliateOffer, now = new Date()): boolean { return offer.affiliateLinkStatus === "active" && Boolean(offer.affiliateUrl) && (!offer.affiliateLinkExpiresAt || new Date(offer.affiliateLinkExpiresAt).getTime() > now.getTime()); }
export function isExplicitlyAffiliateEligible(offer: AffiliateOffer): boolean {
  const metadata = offer.availabilityMetadata ?? {};
  for (const key of ["affiliateEligible", "commissionEligible", "isEligible"]) if (metadata[key] === false) return false;
  return true;
}
function commissionScore(offer: AffiliateOffer): number { const rateScore = offer.commissionRateBps !== undefined ? clamp((offer.commissionRateBps / 2_000) * 100) : 0; if (offer.commissionAmountCents === undefined) return rateScore; return clamp(rateScore * 0.6 + logScore(Math.max(0, offer.commissionAmountCents), 4) * 0.4); }
function bestOffer(productId: string, offers: AffiliateOffer[]): AffiliateOffer | undefined {
  return offers.filter((offer) => offer.productId === productId && offer.status === "active" && isAffiliateLinkUsable(offer) && offer.availability !== "out_of_stock" && isExplicitlyAffiliateEligible(offer)).slice().sort((a, b) => {
    const utilityA = commissionScore(a) * 0.25 + (a.availability === "limited" ? 55 : a.availability === "in_stock" ? 100 : 50) * 0.15;
    const utilityB = commissionScore(b) * 0.25 + (b.availability === "limited" ? 55 : b.availability === "in_stock" ? 100 : 50) * 0.15;
    return utilityB - utilityA || (b.commissionRateBps ?? 0) - (a.commissionRateBps ?? 0) || (b.commissionAmountCents ?? 0) - (a.commissionAmountCents ?? 0) || a.id.localeCompare(b.id);
  })[0];
}

export function scoreOpportunity(input: OpportunityScoringInput): ScoredOpportunity {
  const { product } = input;
  if (product.status !== "active") {
    return {
      product, offerId: undefined, score: 0, reasons: ["Product is inactive"],
      disclaimer: "Score is a decision-support signal based on available catalog data; it does not guarantee conversions or profit.",
      breakdown: { commission: 0, commissionRateBps: 0, commissionAmountCents: 0, demand: 0, demandEvidenceAvailable: false, audienceFit: 0, socialProof: 0, priceAppeal: 0, availability: 0, dataConfidence: 0, confidencePenalty: 0, total: 0 }
    };
  }

  const matchingProductOffers = input.offers.filter((candidate) => candidate.productId === product.id);
  const offer = bestOffer(product.id, input.offers);
  const hasRejectedMatchingOffer = !offer && matchingProductOffers.length > 0;
  const audience = audienceFit(product, input.audience ?? []);
  const quality = product.discoverySignals?.dataQuality;
  const commissionRateBps = Math.max(0, offer?.commissionRateBps ?? 0);
  const commissionAmountCents = Math.max(0, offer?.commissionAmountCents ?? 0);
  const commissionEvidence = offer && (offer.commissionRateBps !== undefined || offer.commissionAmountCents !== undefined)
    ? { score: commissionScore(offer), confidence: 1 } : undefined;

  const salesKnown = metricKnown(product.soldCount, quality?.soldCount);
  const reviewsKnown = metricKnown(product.reviewCount, quality?.reviewCount);
  const salesConfidence = metricConfidence(product.soldCount, quality?.soldCount);
  const reviewsConfidence = metricConfidence(product.reviewCount, quality?.reviewCount);
  const reachSignals = product.discoverySignals;
  const capturedAtMs = reachSignals?.capturedAt ? Date.parse(reachSignals.capturedAt) : Number.NaN;
  const signalAgeMs = Number.isFinite(capturedAtMs) ? Math.max(0, Date.now() - capturedAtMs) : 0;
  const freshness = Number.isFinite(capturedAtMs) ? Math.pow(0.5, signalAgeMs / DISCOVERY_SIGNAL_HALF_LIFE_MS) : 1;
  const audienceReachKnown = typeof reachSignals?.audienceReachScore === "number" && Number.isFinite(reachSignals.audienceReachScore);
  const observedReach = Math.max(reachSignals?.viewCount ?? 0, reachSignals?.impressionCount ?? 0);
  const reachEvidenceKnown = observedReach > 0;
  const demandEvidence = weightedAverage([
    ...(salesKnown ? [{ score: logScore(product.soldCount, 5), weight: 70, confidence: salesConfidence }] : []),
    ...(reviewsKnown ? [{ score: logScore(product.reviewCount, 5), weight: 30, confidence: reviewsConfidence }] : []),
    ...(audienceReachKnown ? [{ score: clamp(reachSignals!.audienceReachScore! * freshness), weight: 15 }] : []),
    ...(reachEvidenceKnown ? [{ score: logScore(observedReach, 8) * freshness, weight: 10 }] : [])
  ]);
  const demand = demandEvidence?.score ?? 0;

  const ratingKnown = metricKnown(product.ratingMilli, quality?.ratingMilli);
  const ratingConfidence = metricConfidence(product.ratingMilli, quality?.ratingMilli);
  const socialEvidence = weightedAverage([
    ...(ratingKnown ? [{ score: clamp((product.ratingMilli! / 50) * 100), weight: 70, confidence: ratingConfidence }] : []),
    ...(reviewsKnown ? [{ score: logScore(product.reviewCount, 6), weight: 30, confidence: reviewsConfidence }] : [])
  ]);
  const socialProof = socialEvidence?.score ?? 0;

  const hasDiscountEvidence = product.originalPriceCents !== undefined && product.originalPriceCents > 0;
  const discount = hasDiscountEvidence && product.originalPriceCents! > product.priceCents
    ? clamp(((product.originalPriceCents! - product.priceCents) / product.originalPriceCents!) * 100) : 0;
  const hasTargetPrice = input.targetPriceMaxCents !== undefined && input.targetPriceMaxCents > 0;
  const targetPrice = hasTargetPrice ? clamp((1 - product.priceCents / input.targetPriceMaxCents!) * 100) : 50;
  const priceEvidence = hasDiscountEvidence || hasTargetPrice
    ? { score: clamp(discount * 0.6 + targetPrice * 0.4), confidence: 1 } : undefined;

  const availabilityKnown = offer?.availability === "in_stock" || offer?.availability === "limited";
  const availability = !offer ? 0 : offer.availability === "in_stock" ? 100 : offer.availability === "limited" ? 55 : 50;
  const audienceEvidence = (input.audience?.length ?? 0) > 0 ? { score: audience.score, confidence: 1 } : undefined;

  // Missing evidence is neutral (50), never a false zero. Keep the denominator fixed
  // so a product cannot receive an inflated score merely because most signals are absent.
  const mediaReadinessKnown = input.mediaReadinessScore !== undefined && Number.isFinite(input.mediaReadinessScore);
  const mediaReadiness = mediaReadinessKnown ? clamp(input.mediaReadinessScore!) : 50;
  const score = clamp(
    (commissionEvidence?.score ?? 50) * WEIGHTS.commission / 100 +
    (demandEvidence?.score ?? 50) * WEIGHTS.demand / 100 +
    (audienceEvidence?.score ?? 50) * WEIGHTS.audienceFit / 100 +
    (socialEvidence?.score ?? 50) * WEIGHTS.socialProof / 100 +
    (priceEvidence?.score ?? 50) * WEIGHTS.priceAppeal / 100 +
    (availabilityKnown ? availability : 50) * WEIGHTS.availability / 100 +
    mediaReadiness * WEIGHTS.mediaReadiness / 100
  );
  const dataConfidence = clamp(
    (commissionEvidence ? WEIGHTS.commission * commissionEvidence.confidence : 0) +
    (demandEvidence ? WEIGHTS.demand * demandEvidence.confidence : 0) +
    (audienceEvidence ? WEIGHTS.audienceFit : 0) +
    (socialEvidence ? WEIGHTS.socialProof * socialEvidence.confidence : 0) +
    (priceEvidence ? WEIGHTS.priceAppeal : 0) +
    (availabilityKnown ? WEIGHTS.availability : 0) +
    (mediaReadinessKnown ? WEIGHTS.mediaReadiness : 0)
  );

  const reasons: string[] = [];
  if (commissionEvidence && commissionEvidence.score >= 60) reasons.push("Strong commission potential");
  if (demandEvidence && demand >= 60) {
    const demandSources = [
      ...(salesKnown && product.soldCount > 0 ? ["recorded sales"] : []),
      ...(reviewsKnown && product.reviewCount > 0 ? ["recorded reviews"] : []),
      ...(audienceReachKnown || reachEvidenceKnown ? ["audience reach"] : [])
    ];
    reasons.push(`Strong demand from ${demandSources.join(", ")}`);
  }
  if (audience.matched.length) reasons.push(`Matches ${audience.matched.join(", ")} audience intent`);
  if (priceEvidence && priceEvidence.score >= 60) reasons.push("Competitive price or discount signal");
  if (socialEvidence && socialProof >= 70) reasons.push("Strong rating and review evidence");
  if (mediaReadinessKnown && mediaReadiness >= 80) reasons.push("Product media is technically ready for the target platforms");
  if (mediaReadinessKnown && mediaReadiness < 50) reasons.push("Product media has technical readiness gaps");
  if (!offer) reasons.push("No active affiliate offer available");
  if (offer?.availability === "limited") reasons.push("Offer availability is limited");
  const missingSignals = [
    !salesKnown && !audienceReachKnown && !reachEvidenceKnown ? "sales/reach data" : undefined,
    !ratingKnown ? "rating data" : undefined,
    !reviewsKnown ? "review count data" : undefined,
    !priceEvidence ? "price comparison data" : undefined,
    !availabilityKnown ? "confirmed availability" : undefined
  ].filter(Boolean);
  if (missingSignals.length) reasons.push(`Additional data unavailable: ${missingSignals.join(", ")}`);

  return {
    product, offerId: offer?.id, score: Math.round(score * 100) / 100, reasons,
    disclaimer: "Score is normalized over observed evidence only. Data confidence indicates how much of the scoring model is supported by verified data; unavailable data is not treated as a zero score. This score does not guarantee conversions or profit.",
    breakdown: {
      commission: Math.round((commissionEvidence?.score ?? (hasRejectedMatchingOffer ? 0 : 50)) * 100) / 100,
      commissionRateBps, commissionAmountCents,
      demand: Math.round((demandEvidence?.score ?? 50) * 100) / 100,
      demandEvidenceAvailable: Boolean(demandEvidence),
      audienceFit: Math.round(audience.score * 100) / 100,
      socialProof: Math.round((socialEvidence?.score ?? 50) * 100) / 100,
      priceAppeal: Math.round((priceEvidence?.score ?? 50) * 100) / 100,
      availability: availabilityKnown ? availability : hasRejectedMatchingOffer ? 0 : 50,
      mediaReadiness: Math.round(mediaReadiness * 100) / 100,
      dataConfidence: Math.round(dataConfidence * 100) / 100,
      confidencePenalty: 0, total: Math.round(score * 100) / 100
    }
  };
}

export function rankOpportunities(inputs: OpportunityScoringInput[]): ScoredOpportunity[] {
  return inputs.map(scoreOpportunity).sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id));
}
