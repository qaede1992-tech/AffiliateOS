import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { MarketplaceProviderRegistry, MockMarketplaceProvider } from "../src/domain/foundations.js";

test("connection lifecycle is unverified until a supported test succeeds and never returns the credential reference", async () => {
  const app = createApp();
  // Default service has no providers, so register a provider through a purpose-built app below.
  await app.close();
  const registry = new MarketplaceProviderRegistry(); registry.register(new MockMarketplaceProvider());
  const { createServices } = await import("../src/domain/container.js"); const { InMemoryAffiliateAccountRepository, InMemoryAffiliateOfferRepository, InMemoryMarketplaceConnectionRepository, InMemoryProductCatalogRepository, InMemoryRepository } = await import("../src/domain/repository.js");
  const repos = { affiliates: new InMemoryRepository<any>(), offers: new InMemoryRepository<any>(), conversions: new InMemoryRepository<any>(), commissions: new InMemoryRepository<any>(), marketplaceConnections: new InMemoryMarketplaceConnectionRepository(), affiliateAccounts: new InMemoryAffiliateAccountRepository(), products: new InMemoryProductCatalogRepository(), affiliateOffers: new InMemoryAffiliateOfferRepository() };
  const configured = createApp(createServices(repos, { run: (work) => work({ conversions: repos.conversions, commissions: repos.commissions }) }, registry));
  const create = await configured.inject({ method: "POST", url: "/api/v1/marketplaces", payload: { name: "Mock connection", slug: "mock-connection", providerSlug: "mock", credentialReference: "vault://affiliateos/mock", enabled: true, configuration: { region: "test" } } });
  assert.equal(create.statusCode, 201); assert.equal(create.json().healthStatus, "unverified"); assert.equal(create.json().credentialReference, undefined); assert.equal(create.json().hasCredentialReference, true);
  const testResult = await configured.inject({ method: "POST", url: "/api/v1/marketplaces/mock-connection/test" });
  assert.equal(testResult.statusCode, 200); assert.equal(testResult.json().healthStatus, "healthy"); assert.equal(testResult.json().status, "active");
  const health = await configured.inject({ method: "GET", url: "/api/v1/marketplaces/mock-connection/health" });
  assert.equal(health.json().status, "healthy"); assert.ok(health.json().lastSuccessfulCheckAt);
  await configured.close();
});

test("connection validation rejects secret-bearing configuration and exposes provider capabilities", async () => {
  const registry = new MarketplaceProviderRegistry(); registry.register(new MockMarketplaceProvider());
  const { createServices } = await import("../src/domain/container.js"); const { InMemoryAffiliateAccountRepository, InMemoryAffiliateOfferRepository, InMemoryMarketplaceConnectionRepository, InMemoryProductCatalogRepository, InMemoryRepository } = await import("../src/domain/repository.js");
  const repos = { affiliates: new InMemoryRepository<any>(), offers: new InMemoryRepository<any>(), conversions: new InMemoryRepository<any>(), commissions: new InMemoryRepository<any>(), marketplaceConnections: new InMemoryMarketplaceConnectionRepository(), affiliateAccounts: new InMemoryAffiliateAccountRepository(), products: new InMemoryProductCatalogRepository(), affiliateOffers: new InMemoryAffiliateOfferRepository() };
  const app = createApp(createServices(repos, { run: (work) => work({ conversions: repos.conversions, commissions: repos.commissions }) }, registry));
  const providers = await app.inject({ method: "GET", url: "/api/v1/marketplaces/providers" });
  assert.deepEqual(providers.json().data[0].capabilities, ["discoverProducts", "searchProducts", "getProduct", "getOffers", "generateAffiliateLink", "syncConversions"]);
  assert.equal(providers.json().data[0].connectionMode, "mock");
  const unsafe = await app.inject({ method: "POST", url: "/api/v1/marketplaces", payload: { name: "Unsafe", slug: "unsafe", providerSlug: "mock", configuration: { apiKey: "definitely-not-allowed" } } });
  assert.equal(unsafe.statusCode, 400); assert.equal(unsafe.json().error, "UNSAFE_PROVIDER_CONFIGURATION");
  await app.close();
});
