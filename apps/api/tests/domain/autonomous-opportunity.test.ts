import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AffiliateOffer, Product } from "@affiliateos/shared";
import { AutonomousOpportunitySelector } from "../../src/domain/autonomous-opportunity.js";

const product = (id: string, overrides: Partial<Product> = {}): Product => ({
  id, marketplaceId: "market-1", externalProductId: id, name: "Skincare Serum", description: "Daily skincare serum",
  category: "skincare", priceCents: 5000, originalPriceCents: 7500, currency: "USD", ratingMilli: 4600,
  reviewCount: 1200, soldCount: 8500, productUrl: `https://example.test/${id}`, status: "active",
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", ...overrides
});

const offer = (productId: string, overrides: Partial<AffiliateOffer> = {}): AffiliateOffer => ({
  id: `offer-${productId}`, productId, affiliateAccountId: "account-1", externalOfferId: `external-${productId}`,
  priceCents: 5000, currency: "USD", commissionRateBps: 1200, availability: "in_stock", availabilityMetadata: {},
  affiliateLinkStatus: "active", status: "active", createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z", ...overrides
});

describe("autonomous opportunity selection", () => {
  it("selects only active, offer-backed opportunities above the policy threshold", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("good"), offers: [offer("good")] },
      { product: product("inactive", { status: "inactive" }), offers: [offer("inactive")] },
      { product: product("no-offer"), offers: [] }
    ], { minimumScore: 60, maximumResults: 5, requiredAudience: ["skincare"] });
    assert.deepEqual(result.selected.map((item) => item.product.id), ["good"]);
    assert.ok(result.rejected.map((item) => item.productId).includes("inactive"));
    assert.ok(result.rejected.map((item) => item.productId).includes("no-offer"));
  });

  it("honors maximum results deterministically", () => {
    const candidates = ["a", "b", "c"].map((id) => ({ product: product(id), offers: [offer(id)] }));
    const result = new AutonomousOpportunitySelector().select(candidates, { minimumScore: 0, maximumResults: 2 });
    assert.equal(result.selected.length, 2);
    assert.deepEqual(result.selected.map((item) => item.product.id), ["a", "b"]);
  });

  it("does not select a product that misses a required audience", () => {
    const result = new AutonomousOpportunitySelector().select([
      { product: product("beauty", { category: "fashion", name: "Running Shoes", description: "Athletic shoes" }), offers: [offer("beauty")] }
    ], { minimumScore: 0, requiredAudience: ["skincare"] });
    assert.equal(result.selected.length, 0);
  });
});
