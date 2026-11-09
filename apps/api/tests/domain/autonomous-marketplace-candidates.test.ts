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
      getAffiliateAccount: async () => ({ affiliateId: "affiliate-1", status: "active" }),
      discoverProducts: async (slug: string) => { calls.push(`discover:${slug}`); return [p]; },
      getOffers: async (slug: string, externalProductId: string) => { calls.push(`offers:${slug}:${externalProductId}`); return [{ ...offer, affiliateUrl: undefined, affiliateLinkStatus: "not_generated" as const }]; },
      generateAffiliateLink: async (slug: string, externalProductId: string, externalOfferId: string) => {
        calls.push(`link:${slug}:${externalProductId}:${externalOfferId}`);
        return { ...offer, affiliateUrl: "https://example.invalid/generated", affiliateLinkStatus: "active" as const };
      }
    } as any;

    const result = await new AutonomousMarketplaceCandidateProvider(marketplace).listCandidates();
    assert.deepEqual(calls, ["discover:marketplace-1", "offers:marketplace-1:external-product-1", "link:marketplace-1:external-product-1:external-offer-1"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].offers[0].id, "offer-1");
  });

  it("loads only active products and offers scoped to the affiliate account for affiliate feeds", async () => {
    const calls: string[] = [];
    const p = product("feed-product");
    const offer = {
      id: "feed-offer",
      productId: p.id,
      affiliateAccountId: "account-feed",
      externalOfferId: "external-feed-offer",
      affiliateUrl: "https://example.invalid/affiliate",
      affiliateLinkStatus: "active" as const,
      status: "active" as const,
      availability: "unknown" as const,
      availabilityMetadata: {},
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    };
    const marketplace = {
      listConnections: async () => [{ id: "marketplace-feed", slug: "feed", connectionMode: "affiliate_feed", enabled: true, status: "active" }],
      getAffiliateAccount: async () => ({ id: "account-feed", affiliateId: "affiliate-feed", status: "active" }),
      listActiveProductsByMarketplace: async (marketplaceId: string, limit: number) => {
        calls.push("products:" + marketplaceId + ":" + limit);
        return [p];
      },
      listActiveAffiliateOffersForProducts: async (accountId: string, productIds: string[]) => {
        calls.push("offers:" + accountId + ":" + productIds.join(","));
        return [offer];
      },
      listProducts: async () => { throw new Error("unscoped product list must not be called"); },
      listAffiliateOffers: async () => { throw new Error("unscoped offer list must not be called"); }
    } as any;

    const result = await new AutonomousMarketplaceCandidateProvider(marketplace, { maxProductsPerConnection: 25 }).listCandidates();

    assert.deepEqual(calls, [
      "products:marketplace-feed:25",
      "offers:account-feed:feed-product"
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].offers[0].id, "feed-offer");
  });

  it("regenerates expired links and excludes a newly expired generated link", async () => {
    const calls: string[] = [];
    const p = product("product-expired");
    const expired = {
      id: "offer-expired",
      productId: p.id,
      affiliateAccountId: "account-1",
      externalOfferId: "external-offer-expired",
      priceCents: 1000,
      currency: "USD",
      commissionRateBps: 1200,
      commissionAmountCents: 120,
      availability: "in_stock" as const,
      availabilityMetadata: {},
      affiliateUrl: "https://example.invalid/old",
      affiliateLinkExpiresAt: "2000-01-01T00:00:00.000Z",
      affiliateLinkStatus: "active" as const,
      status: "active" as const,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    };
    const marketplace = {
      listConnections: async () => [{ slug: "marketplace-1", enabled: true, status: "active" }],
      getAffiliateAccount: async () => ({ affiliateId: "affiliate-1", status: "active" }),
      discoverProducts: async () => [p],
      getOffers: async () => [expired],
      generateAffiliateLink: async () => {
        calls.push("generate");
        return { ...expired, affiliateUrl: "https://example.invalid/generated", affiliateLinkExpiresAt: "2000-01-01T00:00:00.000Z", affiliateLinkStatus: "expired" as const };
      }
    } as any;

    const result = await new AutonomousMarketplaceCandidateProvider(marketplace).listCandidates();
    assert.deepEqual(calls, ["generate"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].offers.length, 0);
  });

  it("skips inactive products before requesting offers", async () => {
    let offerCalls = 0;
    const inactive = product("product-inactive");
    inactive.status = "inactive";
    const marketplace = {
      listConnections: async () => [{ slug: "marketplace-1", enabled: true, status: "active" }],
      getAffiliateAccount: async () => ({ affiliateId: "affiliate-1", status: "active" }),
      discoverProducts: async () => [inactive],
      getOffers: async () => { offerCalls += 1; return []; }
    } as any;

    const result = await new AutonomousMarketplaceCandidateProvider(marketplace).listCandidates();
    assert.equal(result.length, 0);
    assert.equal(offerCalls, 0);
  });

  it("skips inactive connections and isolates discovery failures", async () => {
    const marketplace = {
      listConnections: async () => [
        { slug: "inactive", enabled: false, status: "inactive" },
        { slug: "broken", enabled: true, status: "active" },
        { slug: "healthy", enabled: true, status: "active" }
      ],
      getAffiliateAccount: async () => ({ affiliateId: "affiliate-1", status: "active" }),
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
