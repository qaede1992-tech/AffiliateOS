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
