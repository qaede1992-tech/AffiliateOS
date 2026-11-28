import { randomUUID } from "node:crypto";
import type { OpportunitySelectionPolicy, OpportunitySelectionPoliciesByMarketplace } from "./autonomous-opportunity.js";
import type { AutonomousExecutionService } from "./autonomous-execution.js";
import type { AutonomousMarketplaceCandidateProvider } from "./autonomous-marketplace-candidates.js";
import type { PreMediaEligibilityEvidence, PreMediaEligibilityRepository } from "./pre-media-eligibility.js";
import { MEDIA_READINESS_MAX_CONFIDENCE_LIFT, MEDIA_READINESS_MAX_SCORE_LIFT } from "./opportunity-scoring.js";

export class PreMediaEligibilityRefreshError extends Error {
  constructor(readonly code: "PRE_MEDIA_REFRESH_PRODUCT_NOT_FOUND" | "PRE_MEDIA_REFRESH_OFFER_UNAVAILABLE", message: string, readonly statusCode: number) {
    super(message);
    this.name = "PreMediaEligibilityRefreshError";
  }
}

export class PreMediaEligibilityRefreshService {
  constructor(
    private readonly candidates: Pick<AutonomousMarketplaceCandidateProvider, "getCandidateByProductId">,
    private readonly execution: Pick<AutonomousExecutionService, "previewSelection">,
    private readonly repository: PreMediaEligibilityRepository,
    private readonly policy: OpportunitySelectionPolicy = {},
    private readonly policiesByMarketplace: OpportunitySelectionPoliciesByMarketplace = {},
    private readonly now: () => Date = () => new Date(),
    private readonly maxAgeMs = 24 * 60 * 60 * 1000
  ) {}

  async refresh(productId: string): Promise<{ evidence: PreMediaEligibilityEvidence; reused: boolean }> {
    const candidate = await this.candidates.getCandidateByProductId(productId);
    if (!candidate) throw new PreMediaEligibilityRefreshError("PRE_MEDIA_REFRESH_PRODUCT_NOT_FOUND", "Active Shopee affiliate-feed product and connection were not found.", 404);
    const usableOffers = candidate.offers.filter((offer) =>
      offer.productId === productId && offer.status === "active" && offer.affiliateLinkStatus === "active" &&
      Boolean(offer.affiliateUrl) && (offer.commissionRateBps !== undefined || offer.commissionAmountCents !== undefined)
    );
    if (!usableOffers.length) throw new PreMediaEligibilityRefreshError("PRE_MEDIA_REFRESH_OFFER_UNAVAILABLE", "No active affiliate offer with a commission signal is available for this product.", 409);

    const now = this.now();
    const latest = (await this.repository.listLatestByProduct(productId, 1))[0];
    const latestAge = latest ? now.getTime() - Date.parse(latest.createdAt) : Number.POSITIVE_INFINITY;
    const currentOfferIds = new Set(usableOffers.map((offer) => offer.id));
    if (latest && latest.marketplaceId === candidate.product.marketplaceId && latest.offerId &&
        currentOfferIds.has(latest.offerId) && Number.isFinite(latestAge) && latestAge >= 0 && latestAge <= this.maxAgeMs) {
      return { evidence: latest, reused: true };
    }

    const minimumScore = this.policy.minimumScore ?? 60;
    const minimumDataConfidence = this.policy.minimumDataConfidence ?? 35;
    const preliminaryMinimumScore = Math.max(0, minimumScore - MEDIA_READINESS_MAX_SCORE_LIFT);
    const preliminaryMinimumDataConfidence = Math.max(0, minimumDataConfidence - MEDIA_READINESS_MAX_CONFIDENCE_LIFT);
    const preliminaryPolicies = Object.fromEntries(Object.entries(this.policiesByMarketplace).map(([marketplaceId, value]) => [
      marketplaceId,
      {
        ...value,
        minimumScore: Math.max(0, (value.minimumScore ?? minimumScore) - MEDIA_READINESS_MAX_SCORE_LIFT),
        minimumDataConfidence: Math.max(0, (value.minimumDataConfidence ?? minimumDataConfidence) - MEDIA_READINESS_MAX_CONFIDENCE_LIFT),
        requirePublishableMedia: false,
        requirePublishableVideo: false,
        requireCommissionSignal: true
      }
    ]));
    const evaluation = await this.execution.previewSelection({
      candidates: [{ product: candidate.product, offers: usableOffers }],
      idempotencyNamespace: `pre-media-refresh:${productId}`,
      feedbackHistoryMode: "latest",
      disableAdaptiveExploration: true,
      policy: {
        ...this.policy,
        minimumScore: preliminaryMinimumScore,
        minimumDataConfidence: preliminaryMinimumDataConfidence,
        requirePublishableMedia: false,
        requirePublishableVideo: false,
        requireCommissionSignal: true
      },
      policiesByMarketplace: preliminaryPolicies,
      requirePublishableMedia: false,
      requirePublishableVideo: false,
      requireCommissionSignal: true
    });
    const decision = evaluation.audit.find((item) => item.productId === productId && item.marketplaceId === candidate.product.marketplaceId);
    if (!decision) throw new Error("Targeted pre-media evaluation did not return a decision for the requested product.");
    const selected = evaluation.selected.find((item) => item.product.id === productId);
    const evidence: PreMediaEligibilityEvidence = {
      id: randomUUID(),
      cycleId: randomUUID(),
      productId,
      marketplaceId: candidate.product.marketplaceId,
      offerId: selected?.offerId,
      eligible: decision.selected && Boolean(selected?.offerId),
      score: decision.score,
      policy: {
        ...this.policy,
        ...decision.policy,
        minimumScore: decision.policy.minimumScore ?? preliminaryMinimumScore,
        minimumDataConfidence: decision.policy.minimumDataConfidence ?? preliminaryMinimumDataConfidence,
        requirePublishableMedia: false,
        requirePublishableVideo: false,
        requireCommissionSignal: true
      },
      reasons: decision.reasons ?? [],
      createdAt: now.toISOString()
    };
    await this.repository.saveMany([evidence]);
    return { evidence, reused: false };
  }
}
