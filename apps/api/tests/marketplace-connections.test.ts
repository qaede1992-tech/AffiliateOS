import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { MarketplaceProviderRegistry, MockMarketplaceProvider } from "../src/domain/foundations.js";

function createConfiguredApp() {
  const registry = new MarketplaceProviderRegistry(); registry.register(new MockMarketplaceProvider());
  return import("../src/domain/container.js").then(async ({ createServices }) => {
    const { InMemoryAffiliateAccountRepository, InMemoryAffiliateOfferRepository, InMemoryMarketplaceConnectionRepository, InMemoryProductCatalogRepository, InMemoryRepository } = await import("../src/domain/repository.js");
    const repos = { affiliates: new InMemoryRepository<any>(), offers: new InMemoryRepository<any>(), conversions: new InMemoryRepository<any>(), commissions: new InMemoryRepository<any>(), marketplaceConnections: new InMemoryMarketplaceConnectionRepository(), affiliateAccounts: new InMemoryAffiliateAccountRepository(), products: new InMemoryProductCatalogRepository(), affiliateOffers: new InMemoryAffiliateOfferRepository() };
    return createApp(createServices(repos, { run: (work) => work({ conversions: repos.conversions, commissions: repos.commissions }) }, registry));
  });
}

test("marketplace activation requires explicit confirmation and never returns the credential reference", async () => {
  const configured = await createConfiguredApp();
  const rejectedCreate = await configured.inject({ method: "POST", url: "/api/v1/marketplaces", payload: { name: "Auto enabled", slug: "auto-enabled", providerSlug: "mock", credentialReference: "vault://affiliateos/mock", enabled: true, configuration: { region: "test" } } });
  assert.equal(rejectedCreate.statusCode, 400);

  const create = await configured.inject({ method: "POST", url: "/api/v1/marketplaces", payload: { name: "Mock connection", slug: "mock-connection", providerSlug: "mock", credentialReference: "vault://affiliateos/mock", enabled: false, configuration: { region: "test" } });
  assert.equal(create.statusCode, 201); assert.equal(create.json().enabled, false); assert.equal(create.json().status, "pending"); assert.equal(create.json().credentialReference, undefined); assert.equal(create.json().hasCredentialReference, true);

  const testResult = await configured.inject({ method: "POST", url: "/api/v1/marketplaces/mock-connection/test" });
  assert.equal(testResult.statusCode, 200); assert.equal(testResult.json().healthStatus, "healthy"); assert.equal(testResult.json().status, "inactive"); assert.equal(testResult.json().enabled, false);

  const withoutConfirmation = await configured.inject({ method: "PUT", url: "/api/v1/marketplaces/mock-connection/enabled", payload: { enabled: true } });
  assert.equal(withoutConfirmation.statusCode, 400);

  const confirmed = await configured.inject({ method: "PUT", url: "/api/v1/marketplaces/mock-connection/enabled", payload: { enabled: true, confirmation: "CONFIRM_MARKETPLACE_CONNECTION" } });
  assert.equal(confirmed.statusCode, 200); assert.equal(confirmed.json().enabled, true); assert.equal(confirmed.json().status, "active"); assert.equal(confirmed.json().credentialReference, undefined);

  const disabled = await configured.inject({ method: "PUT", url: "/api/v1/marketplaces/mock-connection/enabled", payload: { enabled: false } });
  assert.equal(disabled.statusCode, 200); assert.equal(disabled.json().enabled, false); assert.equal(disabled.json().status, "inactive");

  const health = await configured.inject({ method: "GET", url: "/api/v1/marketplaces/mock-connection/health" });
  assert.equal(health.json().status, "healthy"); assert.ok(health.json().lastSuccessfulCheckAt);
  await configured.close();
});

test("connection validation rejects secret-bearing configuration and exposes provider capabilities", async () => {
  const app = await createConfiguredApp();
  const providers = await app.inject({ method: "GET", url: "/api/v1/marketplaces/providers" });
  assert.deepEqual(providers.json().data[0].capabilities, ["discoverProducts", "searchProducts", "getProduct", "getOffers", "generateAffiliateLink", "syncConversions"]);
  assert.equal(providers.json().data[0].connectionMode, "mock");
  const unsafe = await app.inject({ method: "POST", url: "/api/v1/marketplaces", payload: { name: "Unsafe", slug: "unsafe", providerSlug: "mock", configuration: { apiKey: "definitely-not-allowed" } } });
  assert.equal(unsafe.statusCode, 400); assert.equal(unsafe.json().error, "UNSAFE_PROVIDER_CONFIGURATION");
  await app.close();
});
