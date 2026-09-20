import { describe, expect, it } from "vitest";
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
    expect(result.score).toBeGreaterThan(70);
    expect(result.offerId).toBe("offer-1");
    expect(result.breakdown.commission).toBeGreaterThan(50);
    expect(result.breakdown.audienceFit).toBe(100);
    expect(result.reasons).toContain("Matches skincare audience intent");
  });

  it("fails closed on missing active affiliate offers", () => {
    const result = scoreOpportunity({ product: product(), offers: [], audience: ["skincare"] });
    expect(result.offerId).toBeUndefined();
    expect(result.breakdown.commission).toBe(0);
    expect(result.breakdown.availability).toBe(0);
    expect(result.reasons).toContain("No active affiliate offer available");
  });

  it("penalizes limited availability", () => {
    const result = scoreOpportunity({ product: product(), offers: [offer({ availability: "limited" })], audience: ["skincare"] });
    expect(result.breakdown.availability).toBe(55);
  });

  it("ranks opportunities deterministically by score and product id", () => {
    const first = product({ id: "product-a" });
    const second = product({ id: "product-b", soldCount: 10, reviewCount: 2, ratingMilli: 3000 });
    const results = rankOpportunities([
      { product: second, offers: [offer({ id: "offer-b", productId: "product-b", commissionRateBps: 500 })], audience: ["skincare"] },
      { product: first, offers: [offer()], audience: ["skincare"] }
    ]);
    expect(results.map((item) => item.product.id)).toEqual(["product-a", "product-b"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});
