import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MarketplaceProviderRegistry, type MarketplaceProvider, validateMarketplaceProviderContract } from "../../src/domain/foundations.js";

const baseProvider = (): MarketplaceProvider => ({
  slug: "test-marketplace",
  displayName: "Test marketplace",
  connectionMode: "official_api",
  capabilities: ["getProduct"],
  validateConfiguration: () => {},
  getProduct: async () => undefined
});

describe("marketplace provider contract", () => {
  it("accepts a provider when every declared capability has an implementation", () => {
    assert.doesNotThrow(() => validateMarketplaceProviderContract(baseProvider()));
    const registry = new MarketplaceProviderRegistry();
    assert.doesNotThrow(() => registry.register(baseProvider()));
  });

  it("rejects a provider that advertises a capability without its adapter method", () => {
    const provider = { ...baseProvider(), capabilities: ["getOffers"] as const };
    assert.throws(() => validateMarketplaceProviderContract(provider), /unsupported capability: getOffers/i);
  });

  it("rejects duplicate capability declarations", () => {
    const provider = { ...baseProvider(), capabilities: ["getProduct", "getProduct"] as const };
    assert.throws(() => validateMarketplaceProviderContract(provider), /duplicate capability: getProduct/i);
  });

  it("prevents a malformed provider from entering the registry", () => {
    const registry = new MarketplaceProviderRegistry();
    const provider = { ...baseProvider(), capabilities: ["generateAffiliateLink"] as const };
    assert.throws(() => registry.register(provider), /unsupported capability: generateAffiliateLink/i);
    assert.deepEqual(registry.list(), []);
  });
});
