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


  it("bounds concurrent product offer processing while preserving result order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const products = [product("one"), product("two"), product("three"), product("four")];
    const marketplace = {
      listConnections: async () => [{ slug: "marketplace-1", enabled: true, status: "active" }],
      discoverProducts: async () => products,
      getOffers: async (_slug: string, externalProductId: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const id = externalProductId.replace("external-", "");
        return [{ id: `offer-${id}`, productId: products.find((item) => item.externalProductId === externalProductId)!.id, affiliateAccountId: "account-1", externalOfferId: `external-offer-${id}`, priceCents: 1000, currency: "USD", commissionRateBps: 1200, availability: "in_stock" as const, availabilityMetadata: {}, affiliateUrl: "https://example.invalid/affiliate", affiliateLinkStatus: "active" as const, status: "active" as const, createdAt: products[0].createdAt, updatedAt: products[0].updatedAt }];
      }
    } as any;

    const result = await new AutonomousMarketplaceCandidateProvider(marketplace, { maxConcurrentProductsPerConnection: 2 }).listCandidates();
    assert.equal(maxInFlight, 2);
    assert.deepEqual(result.map((item) => item.product.id), ["one", "two", "three", "four"]);
  });

  it("bounds concurrent affiliate-link refreshes per product while preserving offer order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const p = product("refresh-many");
    const offers = Array.from({ length: 5 }, (_, index) => ({
      id: `offer-${index + 1}`,
      productId: p.id,
      affiliateAccountId: "account-1",
      externalOfferId: `external-offer-${index + 1}`,
      priceCents: 1000,
      currency: "USD",
      commissionRateBps: 1200,
      availability: "in_stock" as const,
      availabilityMetadata: {},
      affiliateUrl: undefined,
      affiliateLinkStatus: "not_generated" as const,
      status: "active" as const,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    }));
    const marketplace = {
      listConnections: async () => [{ slug: "marketplace-1", enabled: true, status: "active" }],
      discoverProducts: async () => [p],
      getOffers: async () => offers,
      generateAffiliateLink: async (_slug: string, _externalProductId: string, externalOfferId: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, externalOfferId.endsWith("1") ? 10 : 2));
        inFlight -= 1;
        const source = offers.find((offer) => offer.externalOfferId === externalOfferId)!;
        return { ...source, affiliateUrl: `https://example.invalid/${externalOfferId}`, affiliateLinkStatus: "active" as const };
      }
    } as any;

    const result = await new AutonomousMarketplaceCandidateProvider(marketplace, {
      maxConcurrentOffersPerProduct: 2
    }).listCandidates();

    assert.equal(maxInFlight, 2);
    assert.deepEqual(result[0].offers.map((offer) => offer.id), offers.map((offer) => offer.id));
  });

  it("bounds affiliate-link refreshes across products per connection", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const products = [product("gate-one"), product("gate-two")];
    const offersByProduct = new Map(products.map((p) => [p.id, Array.from({ length: 3 }, (_, index) => ({
      id: `${p.id}-offer-${index + 1}`,
      productId: p.id,
      affiliateAccountId: "account-1",
      externalOfferId: `${p.id}-external-offer-${index + 1}`,
      priceCents: 1000,
      currency: "USD",
      commissionRateBps: 1200,
      availability: "in_stock" as const,
      availabilityMetadata: {},
      affiliateUrl: undefined,
      affiliateLinkStatus: "not_generated" as const,
      status: "active" as const,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    }))]));
    const marketplace = {
      listConnections: async () => [{ slug: "marketplace-1", enabled: true, status: "active" }],
      discoverProducts: async () => products,
      getOffers: async (_slug: string, externalProductId: string) => offersByProduct.get(products.find((p) => p.externalProductId === externalProductId)!.id)!,
      generateAffiliateLink: async (_slug: string, _externalProductId: string, externalOfferId: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const source = [...offersByProduct.values()].flat().find((offer) => offer.externalOfferId === externalOfferId)!;
        return { ...source, affiliateUrl: `https://example.invalid/${externalOfferId}`, affiliateLinkStatus: "active" as const };
      }
    } as any;

    await new AutonomousMarketplaceCandidateProvider(marketplace, {
      maxConcurrentProductsPerConnection: 2,
      maxConcurrentOffersPerProduct: 3,
      maxConcurrentAffiliateLinkRefreshesPerConnection: 2
    }).listCandidates();

    assert.equal(maxInFlight, 2);
  });

  it("skips inactive products before requesting offers", async () => {
    let offerCalls = 0;
    const inactive = product("product-inactive");
    inactive.status = "inactive";
    const marketplace = {
      listConnections: async () => [{ slug: "marketplace-1", enabled: true, status: "active" }],
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
