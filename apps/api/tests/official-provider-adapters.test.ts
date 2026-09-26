import assert from "node:assert/strict";
import test from "node:test";
import { TikTokShopAffiliateProvider } from "../src/domain/tiktok-shop-affiliate-provider.js";
import { InstagramContentPublisher } from "../src/domain/instagram-content-publisher.js";
import { TikTokContentPublisher } from "../src/domain/tiktok-content-publisher.js";

test("TikTok Shop adapter exposes the required official affiliate capabilities", async () => {
  const client = {
    testConnection: async () => ({ market: "ID" }),
    discoverProducts: async () => [],
    searchProducts: async () => [],
    getProduct: async () => undefined,
    getOffers: async () => [],
    generateAffiliateLink: async () => ({ url: "https://example.test/affiliate/1" }),
    syncConversions: async () => ({ synced: 0 })
  };
  const provider = new TikTokShopAffiliateProvider(client, { market: "ID", apiVersion: "202508" });
  provider.validateConfiguration({ market: "ID", apiVersion: "202508" });
  assert.equal(provider.connectionMode, "official_api");
  assert.deepEqual(provider.capabilities, [
    "discoverProducts", "searchProducts", "getProduct", "getOffers",
    "generateAffiliateLink", "syncConversions"
  ]);
  assert.deepEqual(await provider.testConnection(), {
    metadata: { provider: "tiktok-shop-affiliate", market: "ID", apiVersion: "202508", ...{ market: "ID" } }
  });
});

test("TikTok Shop adapter rejects malformed version and market configuration", () => {
  const client = {
    testConnection: async () => ({}),
    discoverProducts: async () => [],
    searchProducts: async () => [],
    getProduct: async () => undefined,
    getOffers: async () => [],
    generateAffiliateLink: async () => ({ url: "https://example.test/affiliate/1" }),
    syncConversions: async () => ({ synced: 0 })
  };
  const provider = new TikTokShopAffiliateProvider(client, { market: "ID", apiVersion: "202508" });
  assert.throws(() => provider.validateConfiguration({ market: "id", apiVersion: "202508" }));
  assert.throws(() => provider.validateConfiguration({ market: "ID", apiVersion: "latest" }));
});

test("social adapters expose only their intended platform", () => {
  const client = {
    publish: async () => ({ status: "accepted" as const, providerOperationId: "op-1" }),
    checkPublication: async () => ({ status: "processing" as const })
  };
  const tiktok = new TikTokContentPublisher(client);
  const instagram = new InstagramContentPublisher(client);
  assert.equal(tiktok.supports("tiktok"), true);
  assert.equal(tiktok.supports("instagram"), false);
  assert.equal(instagram.supports("instagram"), true);
  assert.equal(instagram.supports("tiktok"), false);
});
