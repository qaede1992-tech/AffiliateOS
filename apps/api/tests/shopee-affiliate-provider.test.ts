import assert from "node:assert/strict";
import test from "node:test";
import { ShopeeAffiliateProvider } from "../src/domain/shopee-affiliate-provider.js";

const client = {
  testConnection: async () => ({ region: "ID" }),
  productOfferV2: async () => [],
  searchProductOffers: async () => [],
  getProduct: async () => undefined,
  shopOfferV2: async () => [],
  getOffers: async () => [],
  generateShortLink: async () => ({ url: "https://shope.ee/example" }),
  conversionReport: async () => ({ synced: 2 }),
  validatedReport: async () => ({ synced: 3 })
};

test("Shopee Affiliate provider exposes the production marketplace capabilities", async () => {
  const provider = new ShopeeAffiliateProvider(client, { market: "ID", apiVersion: "v2" });

  assert.equal(provider.slug, "shopee-affiliate");
  assert.equal(provider.connectionMode, "official_api");
  assert.deepEqual(provider.capabilities, [
    "discoverProducts",
    "searchProducts",
    "getProduct",
    "getOffers",
    "generateAffiliateLink",
    "syncConversions"
  ]);
  assert.deepEqual(await provider.testConnection(), {
    metadata: { provider: "shopee-affiliate", market: "ID", apiVersion: "v2", region: "ID" }
  });
  assert.deepEqual(await provider.syncConversions("2026-09-25T00:00:00.000Z"), { synced: 5 });
});

test("Shopee Affiliate provider rejects unsafe configuration", () => {
  const provider = new ShopeeAffiliateProvider(client, { market: "ID", apiVersion: "v2" });
  assert.throws(() => provider.validateConfiguration({ market: "id", apiVersion: "v2" }));
  assert.throws(() => provider.validateConfiguration({ market: "ID", apiVersion: "latest" }));
});
