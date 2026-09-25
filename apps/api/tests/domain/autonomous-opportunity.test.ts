import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AffiliateOffer, Product } from "@affiliateos/shared";
import { AutonomousOpportunitySelector } from "../../src/domain/autonomous-opportunity.js";

const product = (id: string, overrides: Partial<Product> = {}): Product => ({
  id,
  marketplaceId: "market-1",
  externalProductId: id,
  name: "Skincare Serum",
  description: "Daily skincare serum",
  category: "skincare",
  priceCents: 5000,
  originalPriceCents: 7500,
  currency: "USD",
  ratingMilli: 4600,
  reviewCount: 1200,
  soldCount: 8500,
  productUrl: `https://example.test/${id}`,
  status: "active",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  ...overrides
});

const offer = (productId: string, overrides: Partial<AffiliateOffer> = {}): AffiliateOffer => ({
  id: `offer-${productId}`,
  productId,
  affiliateAccountId: "account-1",
  externalOfferId: `external-${productId}`,
  priceCents: 5000,
  currency: "USD",
  commissionRateBps: 1200,
  affiliateUrl: `https://example.test/affiliate/${productId}`,
  availability: "in_stock",
  availabilityMetadata: {},
  affiliateLinkStatus: "active",
  status: "active",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  ...overrides
});

describe("autonomous opportunity selection", () => {
  it("prefers marketplace-specific feedback over a product-only fallback", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("a", { marketplaceId: "market-1" }), offers: [offer("a")] },
      { product: product("b", { marketplaceId: "market-2" }), offers: [offer("b")] }
    ], { minimumScore: 0, maximumResults: 1 }, new Map([
      ["market-1:a", { clickCount: 100, conversionRate: 0.1, attributedCommissionCents: 1000, commissionPerClickCents: 0, adjustment: 8, trendAdjustment: 0 }],
      ["a", { clickCount: 100, conversionRate: 0, attributedCommissionCents: 0, commissionPerClickCents: 0, adjustment: -8, trendAdjustment: 0 }],
      ["market-2:b", { clickCount: 100, conversionRate: 0, attributedCommissionCents: 0, commissionPerClickCents: 0, adjustment: -8, trendAdjustment: 0 }]
    ]));
    assert.equal(result.selected[0]?.product.id, "a");
    assert.ok(result.selected[0]?.reasons.some((reason) => reason.includes("positive")));
  });

  it("uses marketplace category feedback when product-specific history is absent", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("category-a", { category: "skincare" }), offers: [offer("category-a")] }
    ], { minimumScore: 0, maximumResults: 1 }, new Map([
      ["market-1:category:skincare", {
        clickCount: 100,
        conversionRate: 0.08,
        attributedCommissionCents: 1000,
        commissionPerClickCents: 10,
        adjustment: 6,
        trendAdjustment: 0
      }]
    ]));
    assert.equal(result.selected[0]?.product.id, "category-a");
    assert.ok(result.selected[0]?.score !== undefined);
    assert.ok(result.selected[0]?.reasons.some((reason) => reason.includes("Historical conversion feedback")));
  });



  it("composes product, category, and audience feedback with bounded weighted influence", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("composite"), offers: [offer("composite")] }
    ], { minimumScore: 0, maximumResults: 1, requiredAudience: ["beauty"] }, new Map([
      ["market-1:composite", { clickCount: 100, conversionRate: 0.08, attributedCommissionCents: 1000, commissionPerClickCents: 10, adjustment: 8, trendAdjustment: 0 }],
      ["market-1:category:skincare", { clickCount: 100, conversionRate: 0.05, attributedCommissionCents: 500, commissionPerClickCents: 5, adjustment: 4, trendAdjustment: 0 }],
      ["market-1:audience:beauty", { clickCount: 100, conversionRate: 0.04, attributedCommissionCents: 400, commissionPerClickCents: 4, adjustment: 2, trendAdjustment: 0 }]
    ]));
    assert.equal(result.selected[0]?.breakdown.performanceAdjustment, 5.6);
    assert.ok(result.selected[0]?.score !== undefined);
    assert.ok(result.selected[0]?.reasons.some((reason) => reason.includes("Historical conversion feedback applied")));
  });

  it("does not materially amplify a single weak signal beyond the global cap", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("bounded"), offers: [offer("bounded")] }
    ], { minimumScore: 0, maximumResults: 1, requiredAudience: ["beauty"] }, new Map([
      ["market-1:bounded", { clickCount: 100, conversionRate: 0, attributedCommissionCents: 0, commissionPerClickCents: 0, adjustment: -8, trendAdjustment: 0 }],
      ["market-1:category:skincare", { clickCount: 100, conversionRate: 0, attributedCommissionCents: 0, commissionPerClickCents: 0, adjustment: -8, trendAdjustment: 0 }],
      ["market-1:audience:beauty", { clickCount: 100, conversionRate: 0, attributedCommissionCents: 0, commissionPerClickCents: 0, adjustment: -8, trendAdjustment: 0 }]
    ]));
    assert.equal(result.selected[0]?.breakdown.performanceAdjustment, -8);
  });

  it("reserves controlled exploration slots for candidates without enough product evidence", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("proven"), offers: [offer("proven")] },
      { product: product("new-a"), offers: [offer("new-a")] },
      { product: product("new-b"), offers: [offer("new-b")] }
    ], { minimumScore: 0, maximumResults: 2, explorationRate: 0.5 }, new Map([
      ["market-1:proven", { clickCount: 100, conversionRate: 0.04, attributedCommissionCents: 500, commissionPerClickCents: 5, adjustment: 8, trendAdjustment: 0 }]
    ]));
    assert.equal(result.selected.length, 2);
    assert.ok(result.selected.some((item) => item.product.id === "new-a"));
    assert.ok(result.selected.some((item) => item.product.id === "proven"));
    assert.ok(result.audit.find((item) => item.productId === "new-a")?.reasons.includes("Selected for controlled exploration"));
    assert.equal(result.audit.find((item) => item.productId === "new-a")?.selectionMode, "exploration");
    assert.equal(result.audit.find((item) => item.productId === "proven")?.selectionMode, "exploitation");
  });

  it("does not force exploration when every eligible product has enough evidence", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("a"), offers: [offer("a")] },
      { product: product("b"), offers: [offer("b")] }
    ], { minimumScore: 0, maximumResults: 1, explorationRate: 0 }, new Map([
      ["market-1:a", { clickCount: 100, conversionRate: 0.04, attributedCommissionCents: 500, commissionPerClickCents: 5, adjustment: 2, trendAdjustment: 0 }],
      ["market-1:b", { clickCount: 100, conversionRate: 0.04, attributedCommissionCents: 500, commissionPerClickCents: 5, adjustment: 1, trendAdjustment: 0 }]
    ]));
    assert.deepEqual(result.selected.map((item) => item.product.id), ["a"]);
  });

  it("selects only active, offer-backed opportunities above the policy threshold", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("good"), offers: [offer("good")] },
      { product: product("inactive", { status: "inactive" }), offers: [offer("inactive")] },
      { product: product("no-offer"), offers: [] }
    ], { minimumScore: 60, maximumResults: 5, requiredAudience: ["skincare"] });
    assert.deepEqual(result.selected.map((item) => item.product.id), ["good"]);
    assert.equal(result.audit.find((item) => item.productId === "good")?.marketplaceId, "market-1");
    assert.equal(result.audit.find((item) => item.productId === "good")?.selected, true);
    assert.ok(result.rejected.map((item) => item.productId).includes("inactive"));
    assert.ok(result.rejected.map((item) => item.productId).includes("no-offer"));
    assert.ok(result.rejected.find((item) => item.productId === "inactive")?.reasons.includes("Product is not active"));
    assert.ok(result.rejected.find((item) => item.productId === "no-offer")?.reasons.includes("No eligible affiliate offer"));
  });

  it("honors maximum results deterministically and explains capped candidates", () => {
    const candidates = ["a", "b", "c"].map((id) => ({ product: product(id), offers: [offer(id)] }));
    const result = new AutonomousOpportunitySelector().select(candidates, { minimumScore: 0, maximumResults: 2 });
    assert.equal(result.selected.length, 2);
    assert.deepEqual(result.selected.map((item) => item.product.id), ["a", "b"]);
    assert.deepEqual(result.rejected, [{ productId: "c", score: result.rejected[0].score, reasons: ["Selection limit reached"] }]);
  });

  it("applies performance feedback before enforcing the selection limit", () => {
    const candidates = ["a", "b"].map((id) => ({ product: product(id), offers: [offer(id)] }));
    const result = new AutonomousOpportunitySelector().select(candidates, { minimumScore: 0, maximumResults: 1 }, new Map([
      ["b", { clickCount: 100, conversionRate: 0.1, attributedCommissionCents: 1000, commissionPerClickCents: 0, adjustment: 8, trendAdjustment: 0 }]
    ]));
    assert.deepEqual(result.selected.map((item) => item.product.id), ["b"]);
    assert.equal(result.rejected[0]?.productId, "a");
    assert.ok(result.selected[0]?.reasons.some((reason) => reason.includes("Historical conversion feedback applied")));
  });

  it("deduplicates repeated products and merges their offers before selection", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("duplicate"), offers: [offer("duplicate", { id: "offer-low", commissionRateBps: 500 })] },
      { product: product("duplicate"), offers: [offer("duplicate", { id: "offer-high", commissionRateBps: 1800 })] },
      { product: product("other"), offers: [offer("other")] }
    ], { minimumScore: 0, maximumResults: 2 });
    assert.equal(result.selected.length, 2);
    assert.equal(result.selected.filter((item) => item.product.id === "duplicate").length, 1);
    assert.equal(result.selected.find((item) => item.product.id === "duplicate")?.offerId, "offer-high");
  });

  it("honors marketplace-specific maximum results independently", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("market-1-a", { marketplaceId: "market-1" }), offers: [offer("market-1-a")] },
      { product: product("market-1-b", { marketplaceId: "market-1" }), offers: [offer("market-1-b")] },
      { product: product("market-2-a", { marketplaceId: "market-2" }), offers: [offer("market-2-a")] },
      { product: product("market-2-b", { marketplaceId: "market-2" }), offers: [offer("market-2-b")] }
    ], { minimumScore: 0 }, {
      "market-1": { maximumResults: 1 },
      "market-2": { maximumResults: 2 }
    });
    assert.equal(result.selected.length, 3);
    assert.equal(result.selected.filter((item) => item.product.marketplaceId === "market-1").length, 1);
    assert.equal(result.selected.filter((item) => item.product.marketplaceId === "market-2").length, 2);
  });

  it("applies an explicit global maximum as a final cap across marketplaces", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("market-1-a", { marketplaceId: "market-1" }), offers: [offer("market-1-a")] },
      { product: product("market-1-b", { marketplaceId: "market-1" }), offers: [offer("market-1-b")] },
      { product: product("market-2-a", { marketplaceId: "market-2" }), offers: [offer("market-2-a")] },
      { product: product("market-2-b", { marketplaceId: "market-2" }), offers: [offer("market-2-b")] }
    ], { minimumScore: 0, maximumResults: 2 }, {
      "market-1": { maximumResults: 2 },
      "market-2": { maximumResults: 2 }
    });
    assert.deepEqual(result.selected.map((item) => item.product.id), ["market-1-a", "market-1-b"]);
  });

  it("uses product-level fallback evidence when classifying exploration", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("fallback-evidence"), offers: [offer("fallback-evidence")] },
      { product: product("new-candidate"), offers: [offer("new-candidate")] }
    ], { minimumScore: 0, maximumResults: 1, explorationRate: 1 }, new Map([
      ["fallback-evidence", { clickCount: 100, conversionRate: 0.08, attributedCommissionCents: 1000, commissionPerClickCents: 10, adjustment: 8, trendAdjustment: 0 }]
    ]));
    assert.deepEqual(result.selected.map((item) => item.product.id), ["fallback-evidence"]);
    assert.equal(result.audit.find((item) => item.productId === "fallback-evidence")?.selectionMode, "exploitation");
  });

  it("enforces a minimum commission rate", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("low-commission"), offers: [offer("low-commission", { commissionRateBps: 500 })] },
      { product: product("high-commission"), offers: [offer("high-commission", { commissionRateBps: 1500 })] }
    ], { minimumScore: 0, minimumCommissionRateBps: 1000 });
    assert.deepEqual(result.selected.map((item) => item.product.id), ["high-commission"]);
    assert.ok(result.rejected.find((item) => item.productId === "low-commission")?.reasons.includes("Commission rate is below the minimum"));
  });

  it("enforces a minimum demand score", () => {
    const lowDemand = product("low-demand", { soldCount: 0, reviewCount: 0 });
    const result = new AutonomousOpportunitySelector().select([
      { product: lowDemand, offers: [offer("low-demand")] },
      { product: product("high-demand"), offers: [offer("high-demand")] }
    ], { minimumScore: 0, minimumDemandScore: 10 });
    assert.deepEqual(result.selected.map((item) => item.product.id), ["high-demand"]);
    assert.ok(result.rejected.find((item) => item.productId === "low-demand")?.reasons.includes("Demand score is below the minimum"));
  });

  it("clamps invalid policy guard values to safe bounds", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("guarded"), offers: [offer("guarded")] }
    ], { minimumScore: 0, minimumCommissionRateBps: -100, minimumDemandScore: 200 });
    assert.equal(result.selected.length, 0);
    assert.ok(result.rejected[0]?.reasons.includes("Demand score is below the minimum"));
  });

  it("applies marketplace-specific policy overrides without changing the default policy", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("default-market"), offers: [offer("default-market", { commissionRateBps: 800 })] },
      { product: product("strict-market", { marketplaceId: "market-2" }), offers: [offer("strict-market", { commissionRateBps: 800 })] }
    ], { minimumScore: 0, minimumCommissionRateBps: 500 }, {
      "market-2": { minimumCommissionRateBps: 1000 }
    });
    assert.deepEqual(result.selected.map((item) => item.product.id), ["default-market"]);
    assert.ok(result.rejected.find((item) => item.productId === "strict-market")?.reasons.includes("Commission rate is below the minimum"));
  });

  it("falls back to the default policy when no marketplace override exists", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("unconfigured-market", { marketplaceId: "market-unknown" }), offers: [offer("unconfigured-market", { commissionRateBps: 800 })] }
    ], { minimumScore: 0, minimumCommissionRateBps: 500 }, {
      "market-2": { minimumCommissionRateBps: 1000 }
    });
    assert.deepEqual(result.selected.map((item) => item.product.id), ["unconfigured-market"]);
  });

  it("records the effective marketplace policy for rejected opportunities", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("audited", { marketplaceId: "market-2" }), offers: [offer("audited", { commissionRateBps: 500 })] }
    ], { minimumScore: 0, minimumCommissionRateBps: 100 }, new Map(), {
      "market-2": { minimumCommissionRateBps: 1000 }
    });
    const audit = result.audit[0];
    assert.equal(audit?.marketplaceId, "market-2");
    assert.equal(audit?.selected, false);
    assert.equal(audit?.policy.minimumCommissionRateBps, 1000);
    assert.ok(audit?.reasons.includes("Commission rate is below the minimum"));
  });

  it("does not select a product that misses a required audience", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("beauty", { category: "fashion", name: "Running Shoes", description: "Athletic shoes" }), offers: [offer("beauty")] }
    ], { minimumScore: 0, requiredAudience: ["skincare"] });
    assert.equal(result.selected.length, 0);
    assert.ok(result.rejected[0]?.reasons.includes("Does not match the required audience"));
  });
});


describe("autonomous commission amount guard", () => {
  it("rejects low expected commission amounts even when the rate is sufficient", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("low-amount", { priceCents: 1000 }), offers: [offer("low-amount", { commissionRateBps: 2000, commissionAmountCents: 100 })] },
      { product: product("high-amount"), offers: [offer("high-amount", { commissionRateBps: 1200, commissionAmountCents: 800 })] }
    ], { minimumScore: 0, minimumCommissionAmountCents: 500 });
    assert.deepEqual(result.selected.map((item) => item.product.id), ["high-amount"]);
    assert.ok(result.rejected.find((item) => item.productId === "low-amount")?.reasons.includes("Commission amount is below the minimum"));
  });
  it("uses required audience performance when product and category history are absent", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("audience-a"), offers: [offer("audience-a")] }
    ], { minimumScore: 0, maximumResults: 1, requiredAudience: ["beauty"] }, new Map([
      ["market-1:audience:beauty", {
        clickCount: 100,
        conversionRate: 0.08,
        attributedCommissionCents: 1000,
        commissionPerClickCents: 10,
        adjustment: 4,
        trendAdjustment: 0
      }]
    ]));
    assert.ok(result.selected[0]?.reasons.some((reason) => reason.includes("Historical conversion feedback")));
  });

});
