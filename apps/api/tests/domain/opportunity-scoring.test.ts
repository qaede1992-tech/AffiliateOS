import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AffiliateOffer, Product } from "@affiliateos/shared";
import { rankOpportunities, scoreOpportunity } from "../../src/domain/opportunity-scoring.js";

const product = (overrides: Partial<Product> = {}): Product => ({
  id: "product-1",
  marketplaceId: "market-1",
  externalProductId: "ext-1",
  name: "Hydrating Skincare Serum",
  description: "Daily facial serum for healthy skin",
  category: "skincare",
  priceCents: 5000,
  originalPriceCents: 7500,
  currency: "USD",
  ratingMilli: 4600,
  reviewCount: 1200,
  soldCount: 8500,
  productUrl: "https://example.test/product",
  status: "active",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  ...overrides
});

const offer = (overrides: Partial<AffiliateOffer> = {}): AffiliateOffer => ({
  id: "offer-1",
  productId: "product-1",
  affiliateAccountId: "account-1",
  externalOfferId: "ext-offer-1",
  priceCents: 5000,
  currency: "USD",
  commissionRateBps: 1200,
  availability: "in_stock",
  availabilityMetadata: {},
  affiliateLinkStatus: "active",
  status: "active",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  ...overrides
});

describe("opportunity scoring", () => {
  it("combines commission, demand, audience fit and product signals", () => {
    const result = scoreOpportunity({ product: product(), offers: [offer()], audience: ["skincare"] });
    assert.ok(result.score > 70);
    assert.equal(result.offerId, "offer-1");
    assert.ok(result.breakdown.commission > 50);
    assert.equal(result.breakdown.audienceFit, 100);
    assert.ok(result.reasons.includes("Matches skincare audience intent"));
  });

  it("fails closed on missing active affiliate offers", () => {
    const result = scoreOpportunity({ product: product(), offers: [], audience: ["skincare"] });
    assert.equal(result.offerId, undefined);
    assert.equal(result.breakdown.commission, 0);
    assert.equal(result.breakdown.availability, 0);
    assert.ok(result.reasons.includes("No active affiliate offer available"));
  });

  it("penalizes limited availability", () => {
    const result = scoreOpportunity({ product: product(), offers: [offer({ availability: "limited" })], audience: ["skincare"] });
    assert.equal(result.breakdown.availability, 55);
  });

  it("ranks opportunities deterministically by score and product id", () => {
    const first = product({ id: "product-a" });
    const second = product({ id: "product-b", soldCount: 10, reviewCount: 2, ratingMilli: 3000 });
    const results = rankOpportunities([
      { product: second, offers: [offer({ id: "offer-b", productId: "product-b", commissionRateBps: 500 })], audience: ["skincare"] },
      { product: first, offers: [offer()], audience: ["skincare"] }
    ]);
    assert.deepEqual(results.map((item) => item.product.id), ["product-a", "product-b"]);
    assert.ok(results[0].score > results[1].score);
  });
});
