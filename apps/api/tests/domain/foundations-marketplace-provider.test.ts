import assert from "node:assert/strict";
import test from "node:test";
import { MarketplaceProviderRegistry, MockMarketplaceProvider } from "../../src/domain/foundations.js";

test("marketplace provider registry rejects declared capabilities without implementations", () => {
  const registry = new MarketplaceProviderRegistry();
  const provider = {
    ...new MockMarketplaceProvider(),
    slug: "broken-provider",
    capabilities: ["discoverProducts", "generateAffiliateLink"] as const,
    generateAffiliateLink: undefined
  };
  assert.throws(() => registry.register(provider), /declares capability generateAffiliateLink but does not implement it/i);
});

test("marketplace provider registry accepts a provider whose declared capabilities are implemented", () => {
  const registry = new MarketplaceProviderRegistry();
  registry.register(new MockMarketplaceProvider());
  assert.equal(registry.get("mock").slug, "mock");
});

test("marketplace provider registry rejects an empty provider slug", () => {
  const registry = new MarketplaceProviderRegistry();
  const provider = { ...new MockMarketplaceProvider(), slug: "   " };
  assert.throws(() => registry.register(provider), /provider slug is required/i);
});
