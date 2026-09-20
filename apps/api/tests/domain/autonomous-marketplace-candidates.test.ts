import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousMarketplaceCandidateProvider } from "../../src/domain/autonomous-marketplace-candidates.js";

const product = (id: string, updatedAt = "2026-09-21T10:00:00.000Z") => ({
  id,
  marketplaceId: "marketplace-1",
  externalProductId: `external-${id}`,
  name: `Product ${id}`,
  description: "Useful product",
  category: "home",
  priceCents: 1000,
  originalPriceCents: 1200,
  currency: "USD",
  ratingMilli: 4500,
  reviewCount: 100,
  soldCount: 1000,
  imageUrl: "https://example.invalid/image.jpg",
  productUrl: "https://example.invalid/product",
  status: "active" as const,
  createdAt: updatedAt,
  updatedAt
});

describe("autonomous marketplace candidate provider", () => {
  it("discovers products and refreshes their offers from active connections", async () => {
    const calls: string[] = [];
    const p = product("product-1");
    const offer = { id: "offer-1", productId: p.id, affiliateAccountId: "account-1", externalOfferId: "external-offer-1", priceCents: 1000, currency: "USD", commissionRateBps: 1200, commissionAmountCents: 120, availability: "in_stock" as const, availabilityMetadata: {}, affiliateUrl: "https://example.invalid/affiliate", affiliateLinkStatus: "active" as const, status: "active" as const, createdAt: p.createdAt, updatedAt: p.updatedAt };
    const marketplace = {
      listConnections: async () => [{ slug: "marketplace-1", enabled: true, status: "active" }],
      discoverProducts: async (slug: string) => { calls.push(`discover:${slug}`); return [p]; },
      getOffers: async (slug: string, externalProductId: string) => { calls.push(`offers:${slug}:${externalProductId}`); return [offer]; }
    } as any;

    const result = await new AutonomousMarketplaceCandidateProvider(marketplace).listCandidates();
    assert.deepEqual(calls, ["discover:marketplace-1", "offers:marketplace-1:external-product-1"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].offers[0].id, "offer-1");
  });

  it("skips inactive connections and isolates discovery failures", async () => {
    const marketplace = {
      listConnections: async () => [
        { slug: "inactive", enabled: false, status: "inactive" },
        { slug: "broken", enabled: true, status: "active" },
        { slug: "healthy", enabled: true, status: "active" }
      ],
      discoverProducts: async (slug: string) => {
        if (slug === "broken") throw new Error("provider unavailable");
        return [product("product-healthy")];
      },
      getOffers: async () => []
    } as any;

    const result = await new AutonomousMarketplaceCandidateProvider(marketplace).listCandidates();
    assert.equal(result.length, 1);
    assert.equal(result[0].product.id, "product-healthy");
  });
});
