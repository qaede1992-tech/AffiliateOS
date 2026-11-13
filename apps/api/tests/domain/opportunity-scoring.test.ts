import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AffiliateOffer, Product } from "@affiliateos/shared";
import { rankOpportunities, scoreOpportunity } from "../../src/domain/opportunity-scoring.js";

const product = (overrides: Partial<Product> = {}): Product => ({
  id: "product-1", marketplaceId: "market-1", externalProductId: "ext-1", name: "Hydrating Skincare Serum", description: "Daily facial serum for healthy skin", category: "skincare", priceCents: 5000, originalPriceCents: 7500, currency: "USD", ratingMilli: 4600, reviewCount: 1200, soldCount: 8500, productUrl: "https://example.test/product", status: "active", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", ...overrides
});

const offer = (overrides: Partial<AffiliateOffer> = {}): AffiliateOffer => ({
  id: "offer-1", productId: "product-1", affiliateAccountId: "account-1", externalOfferId: "ext-offer-1", priceCents: 5000, currency: "USD", commissionRateBps: 1200, affiliateUrl: "https://example.test/affiliate/offer-1", availability: "in_stock", availabilityMetadata: {}, affiliateLinkStatus: "active", status: "active", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", ...overrides
});

describe("opportunity scoring", () => {
  it("combines commission, demand, audience fit and product signals", () => {
    const result = scoreOpportunity({ product: product(), offers: [offer()], audience: ["skincare"] });
    assert.ok(result.score > 70); assert.equal(result.offerId, "offer-1"); assert.ok(result.breakdown.commission > 50); assert.equal(result.breakdown.audienceFit, 100); assert.ok(result.reasons.includes("Matches skincare audience intent"));
  });
  it("includes verified product media readiness as a weighted scoring signal", () => {
    const weakMedia = scoreOpportunity({ product: product(), offers: [offer()], audience: ["skincare"], mediaReadinessScore: 0 });
    const readyMedia = scoreOpportunity({ product: product(), offers: [offer()], audience: ["skincare"], mediaReadinessScore: 100 });
    assert.equal(weakMedia.breakdown.mediaReadiness, 0);
    assert.equal(readyMedia.breakdown.mediaReadiness, 100);
    assert.equal(readyMedia.score - weakMedia.score, 10);
    assert.ok(readyMedia.reasons.includes("Product media is technically ready for the target platforms"));
    assert.ok(weakMedia.reasons.includes("Product media has technical readiness gaps"));
  });
  it("excludes inactive products from scoring", () => {
    const result = scoreOpportunity({ product: product({ status: "inactive" }), offers: [offer()], audience: ["skincare"] });
    assert.equal(result.score, 0);
    assert.equal(result.offerId, undefined);
    assert.equal(result.breakdown.total, 0);
    assert.ok(result.reasons.includes("Product is inactive"));
  });
  it("fails closed on missing active affiliate offers", () => { const result = scoreOpportunity({ product: product(), offers: [], audience: ["skincare"] }); assert.equal(result.offerId, undefined); assert.equal(result.breakdown.commission, 50); assert.equal(result.breakdown.availability, 50); assert.ok(result.reasons.includes("No active affiliate offer available")); });
  it("rejects offers belonging to another product", () => { const result = scoreOpportunity({ product: product(), offers: [offer({ productId: "different-product" })], audience: ["skincare"] }); assert.equal(result.offerId, undefined); assert.equal(result.breakdown.commission, 50); });
  it("rejects inactive affiliate links and missing destination URLs", () => { const inactive = scoreOpportunity({ product: product(), offers: [offer({ affiliateLinkStatus: "inactive" })] }); const missingUrl = scoreOpportunity({ product: product(), offers: [offer({ affiliateUrl: undefined })] }); assert.equal(inactive.offerId, undefined); assert.equal(missingUrl.offerId, undefined); });
  it("fails closed on expired affiliate links", () => {
    const expired = offer({ affiliateLinkExpiresAt: "2026-09-20T00:00:00.000Z" });
    const result = scoreOpportunity({ product: product(), offers: [expired], audience: ["skincare"] });
    assert.equal(result.offerId, undefined);
    assert.equal(result.breakdown.commission, 0);
  });
  it("does not mistake missing demand evidence for a measured zero", () => {
    const result = scoreOpportunity({
      product: product({ soldCount: 0, reviewCount: 0, ratingMilli: undefined, discoverySignals: { dataQuality: { soldCount: "missing", reviewCount: "missing", ratingMilli: "missing" } } }),
      offers: [offer()]
    });
    assert.equal(result.breakdown.demand, 50);
    assert.equal(result.breakdown.demandEvidenceAvailable, false);
  });
  it("does not mutate the candidate offer collection", () => { const lower = offer({ id: "offer-b", commissionRateBps: 500 }); const higher = offer({ id: "offer-a", commissionRateBps: 1500 }); const offers = [lower, higher]; scoreOpportunity({ product: product(), offers }); assert.deepEqual(offers.map((item) => item.id), ["offer-b", "offer-a"]); });
  it("prefers an in-stock offer when commission utility is otherwise comparable", () => {
    const result = scoreOpportunity({
      product: product(),
      offers: [
        offer({ id: "limited-high", commissionRateBps: 1400, availability: "limited" }),
        offer({ id: "stock-balanced", commissionRateBps: 1200, availability: "in_stock" })
      ],
      audience: ["skincare"]
    });
    assert.equal(result.offerId, "stock-balanced");
    assert.equal(result.breakdown.availability, 100);
  });
    it("penalizes limited availability", () => { const result = scoreOpportunity({ product: product(), offers: [offer({ availability: "limited" })], audience: ["skincare"] }); assert.equal(result.breakdown.availability, 55); });
  it("selects the higher commission value when rates alone disagree", () => {
    const result = scoreOpportunity({
      product: product(),
      offers: [
        offer({ id: "high-rate-low-value", commissionRateBps: 1800, commissionAmountCents: 100 }),
        offer({ id: "lower-rate-high-value", commissionRateBps: 1400, commissionAmountCents: 2500 })
      ],
      audience: ["skincare"]
    });
    assert.equal(result.offerId, "lower-rate-high-value");
  });
  it("accounts for commission value when commission amounts are provided", () => {
    const lowValue = scoreOpportunity({ product: product({ id: "low-value" }), offers: [offer({ id: "low-value-offer", productId: "low-value", commissionRateBps: 1800, commissionAmountCents: 100 })], audience: ["skincare"] });
    const highValue = scoreOpportunity({ product: product({ id: "high-value" }), offers: [offer({ id: "high-value-offer", productId: "high-value", commissionRateBps: 1400, commissionAmountCents: 2500 })], audience: ["skincare"] });
    assert.ok(highValue.breakdown.commission > lowValue.breakdown.commission);
  });
  it("does not penalize an unconstrained audience", () => {
    const result = scoreOpportunity({ product: product(), offers: [offer()] });
    assert.equal(result.breakdown.audienceFit, 50);
    assert.equal(result.breakdown.confidencePenalty, 0);
  });
  it("uses persisted audience reach signals in demand scoring", () => {
    const baseline = scoreOpportunity({ product: product(), offers: [offer()], audience: ["skincare"] });
    const highReach = scoreOpportunity({
      product: product({ discoverySignals: { audienceReachScore: 100, viewCount: 1000000 } }),
      offers: [offer()],
      audience: ["skincare"]
    });
    assert.ok(highReach.breakdown.demand > baseline.breakdown.demand);
    assert.ok(highReach.reasons.includes("Strong demand from recorded sales, recorded reviews, audience reach"));
  });
  it("decays stale discovery reach signals instead of treating them as current", () => {
    const recent = scoreOpportunity({
      product: product({ discoverySignals: { audienceReachScore: 100, viewCount: 1000000, capturedAt: new Date().toISOString() } }),
      offers: [offer()],
      audience: ["skincare"]
    });
    const stale = scoreOpportunity({
      product: product({ discoverySignals: { audienceReachScore: 100, viewCount: 1000000, capturedAt: "2026-07-01T00:00:00.000Z" } }),
      offers: [offer()],
      audience: ["skincare"]
    });
    assert.ok(recent.breakdown.demand > stale.breakdown.demand);
  });
  it("ranks opportunities deterministically by score and product id", () => {
    const first = product({ id: "product-a" });
    const second = product({ id: "product-b", soldCount: 10, reviewCount: 2, ratingMilli: 3000 });
    const results = rankOpportunities([
      { product: second, offers: [offer({ id: "offer-b", productId: "product-b", commissionRateBps: 500 })], audience: ["skincare"] },
      { product: first, offers: [offer({ productId: "product-a" })], audience: ["skincare"] }
    ]);
    assert.deepEqual(results.map((item) => item.product.id), ["product-a", "product-b"]);
    assert.ok(results[0].score > results[1].score);
  });
  it("does not treat unavailable rating and review metrics as zero-score evidence", () => {
    const incomplete = product({
      ratingMilli: undefined,
      reviewCount: 0,
      discoverySignals: { dataQuality: { ratingMilli: "missing", reviewCount: "missing", soldCount: "exact", source: "shopee-affiliate-csv" } }
    });
    const result = scoreOpportunity({ product: incomplete, offers: [offer()], audience: ["skincare"] });
    assert.ok(result.score > 70);
    assert.equal(result.breakdown.socialProof, 50);
    assert.ok(result.breakdown.dataConfidence < 100);
    assert.ok(result.reasons.includes("Additional data unavailable: rating data, review count data"));
  });

  it("normalizes demand over known sales evidence when review count is unavailable", () => {
    const exactSales = product({
      soldCount: 8500,
      reviewCount: 0,
      ratingMilli: undefined,
      discoverySignals: { dataQuality: { soldCount: "exact", reviewCount: "missing", ratingMilli: "missing" } }
    });
    const lowerBoundSales = product({
      soldCount: 8500,
      reviewCount: 0,
      ratingMilli: undefined,
      discoverySignals: { dataQuality: { soldCount: "lower_bound", reviewCount: "missing", ratingMilli: "missing" } }
    });
    const exact = scoreOpportunity({ product: exactSales, offers: [offer()], audience: ["skincare"] });
    const lowerBound = scoreOpportunity({ product: lowerBoundSales, offers: [offer()], audience: ["skincare"] });
    assert.ok(exact.breakdown.demand > 75);
    assert.equal(exact.breakdown.demand, lowerBound.breakdown.demand);
    assert.ok(exact.breakdown.dataConfidence > lowerBound.breakdown.dataConfidence);
  });

  it("does not assume an unknown offer availability is in stock", () => {
    const result = scoreOpportunity({
      product: product(),
      offers: [offer({ availability: "unknown" })],
      audience: ["skincare"]
    });
    assert.equal(result.breakdown.availability, 50);
    assert.ok(result.breakdown.dataConfidence < 100);
  });

  it("preserves zero as a measured value only when its quality is explicitly exact", () => {
    const unknownZero = product({
      soldCount: 0,
      reviewCount: 0,
      ratingMilli: undefined,
      discoverySignals: { dataQuality: { soldCount: "missing", reviewCount: "missing", ratingMilli: "missing" } }
    });
    const measuredZero = product({
      soldCount: 0,
      reviewCount: 0,
      ratingMilli: undefined,
      discoverySignals: { dataQuality: { soldCount: "exact", reviewCount: "exact", ratingMilli: "missing" } }
    });
    const unknown = scoreOpportunity({ product: unknownZero, offers: [offer()], audience: ["skincare"] });
    const measured = scoreOpportunity({ product: measuredZero, offers: [offer()], audience: ["skincare"] });
    assert.equal(unknown.breakdown.demand, 50);
    assert.equal(measured.breakdown.demand, 0);
    assert.ok(measured.breakdown.dataConfidence > unknown.breakdown.dataConfidence);
  });

});


  it("uses verified imported rating and review metrics as positive social-proof evidence", () => {
    const enriched = product({
      soldCount: 8500,
      reviewCount: 1200,
      ratingMilli: 4900,
      discoverySignals: {
        dataQuality: {
          soldCount: "exact",
          reviewCount: "lower_bound",
          ratingMilli: "exact",
          source: "shopee-affiliate-csv",
        },
      },
    });
    const result = scoreOpportunity({ product: enriched, offers: [offer()], audience: ["skincare"] });
    assert.ok(result.breakdown.demand > 70);
    assert.ok(result.breakdown.socialProof > 80);
    assert.ok(result.breakdown.dataConfidence > 80);
    assert.ok(result.reasons.includes("Strong rating and review evidence"));
  });


  it("explains sales-only demand without implying that ratings or reviews were observed", () => {
    const result = scoreOpportunity({
      product: product({
        soldCount: 10_000,
        reviewCount: 0,
        ratingMilli: undefined,
        discoverySignals: {
          dataQuality: {
            soldCount: "lower_bound",
            reviewCount: "missing",
            ratingMilli: "missing",
            source: "shopee-affiliate-csv",
          },
        },
      }),
      offers: [offer()],
      audience: ["skincare"],
    });
    assert.ok(result.reasons.includes("Strong demand from recorded sales"));
    assert.ok(result.reasons.includes("Additional data unavailable: rating data, review count data"));
    assert.ok(!result.reasons.some((reason) => reason.includes("recorded reviews")));
  });


it("does not describe measured zero counts as positive demand sources", () => {
  const result = scoreOpportunity({
    product: product({
      soldCount: 100_000,
      reviewCount: 0,
      ratingMilli: undefined,
      discoverySignals: {
        dataQuality: {
          soldCount: "exact",
          reviewCount: "exact",
          ratingMilli: "missing",
          source: "shopee-affiliate-csv",
        },
      },
    }),
    offers: [offer()],
  });

  assert.ok(result.reasons.includes("Strong demand from recorded sales"));
  assert.ok(!result.reasons.some((reason) => reason.includes("recorded reviews")));
});
