import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousMarketplaceCandidateProvider } from "../src/domain/autonomous-marketplace-candidates.js";

const product = (id: string, status: "active" | "inactive") => ({
  id,
  marketplaceId: "marketplace-1",
  externalProductId: id,
  name: id,
  priceCents: 1000,
  currency: "USD",
  status,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
} as any);

const offer = (productId: string) => ({
  id: `offer-${productId}`,
  productId,
  affiliateAccountId: "account-1",
  status: "active",
  affiliateLinkStatus: "active",
  affiliateUrl: `https://example.test/${productId}`,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
} as any);

test("applies the per-connection product limit after filtering inactive products", async () => {
  const marketplace = {
    listConnections: async () => [{ slug: "mock", enabled: true, status: "active" }],
    getAffiliateAccount: async () => ({ affiliateId: "affiliate-1", status: "active" }),
    discoverProducts: async () => [
      product("inactive-1", "inactive"),
      product("inactive-2", "inactive"),
      product("active-1", "active"),
      product("active-2", "active")
    ],
    getOffers: async (_slug: string, productId: string) => [offer(productId)]
  };

  const provider = new AutonomousMarketplaceCandidateProvider(marketplace as any, {
    maxProductsPerConnection: 2
  });

  const candidates = await provider.listCandidates();

  assert.deepEqual(
    candidates.map((candidate) => candidate.product.id),
    ["active-1", "active-2"]
  );
});


test("skips active marketplace connections without a bound active affiliate account", async () => {
  const marketplace = {
    listConnections: async () => [
      { slug: "unbound", enabled: true, status: "active" },
      { slug: "bound", enabled: true, status: "active" }
    ],
    getAffiliateAccount: async (slug: string) => slug === "bound"
      ? ({ affiliateId: "affiliate-1", status: "active" })
      : ({ affiliateId: undefined, status: "active" }),
    discoverProducts: async (_slug: string) => [product("bound-product", "active")],
    getOffers: async (_slug: string, productId: string) => [offer(productId)]
  };

  const provider = new AutonomousMarketplaceCandidateProvider(marketplace as any);
  const candidates = await provider.listCandidates();

  assert.deepEqual(candidates.map((candidate) => candidate.product.id), ["bound-product"]);
});


test("uses persisted products and affiliate offers for affiliate-feed connections", async () => {
  const feedProduct = {
    ...product("feed-product", "active"),
    marketplaceId: "feed-marketplace"
  };
  const feedOffer = {
    ...offer(feedProduct.id),
    affiliateAccountId: "feed-account"
  };
  let discoverCalled = false;
  let getOffersCalled = false;
  const marketplace = {
    listConnections: async () => [{
      id: "feed-marketplace",
      slug: "shopee-affiliate-feed",
      connectionMode: "affiliate_feed",
      enabled: true,
      status: "active"
    }],
    getAffiliateAccount: async () => ({
      id: "feed-account",
      affiliateId: "affiliate-1",
      status: "active"
    }),
    discoverProducts: async () => {
      discoverCalled = true;
      return [];
    },
    getOffers: async () => {
      getOffersCalled = true;
      return [];
    },
    listProducts: async () => [feedProduct],
    listAffiliateOffers: async () => [feedOffer]
  };

  const provider = new AutonomousMarketplaceCandidateProvider(marketplace as any);
  const candidates = await provider.listCandidates();

  assert.equal(discoverCalled, false);
  assert.equal(getOffersCalled, false);
  assert.deepEqual(candidates.map((candidate) => candidate.product.id), ["feed-product"]);
  assert.deepEqual(candidates[0]?.offers.map((item) => item.id), ["offer-feed-product"]);
});


test("does not generate affiliate links when preview disables link resolution", async () => {
  let generateCalls = 0;
  const candidateProduct = product("preview-product", "active");
  const candidateOffer = {
    ...offer(candidateProduct.id),
    affiliateUrl: undefined,
    affiliateLinkStatus: "not_generated",
    externalOfferId: "external-offer-1"
  };
  const marketplace = {
    listConnections: async () => [{ slug: "mock", enabled: true, status: "active" }],
    getAffiliateAccount: async () => ({ affiliateId: "affiliate-1", status: "active" }),
    discoverProducts: async () => [candidateProduct],
    getOffers: async () => [candidateOffer],
    generateAffiliateLink: async () => {
      generateCalls += 1;
      return { ...candidateOffer, affiliateUrl: "https://example.test/generated", affiliateLinkStatus: "active" };
    }
  };

  const provider = new AutonomousMarketplaceCandidateProvider(marketplace as any);
  const candidates = await provider.listCandidates({ resolveAffiliateLinks: false });

  assert.equal(generateCalls, 0);
  assert.deepEqual(candidates[0]?.offers, []);
});
