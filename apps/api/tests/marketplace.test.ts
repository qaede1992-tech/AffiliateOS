import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { MarketplaceProviderRegistry, MockMarketplaceProvider } from "../src/domain/foundations.js";

const connection = {
  id: "00000000-0000-4000-8000-000000000011", name: "Test catalog", slug: "test-catalog", providerSlug: "mock", connectionMode: "mock" as const, status: "active" as const, enabled: true,
  configuration: {}, healthStatus: "healthy" as const, healthMetadata: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
};
test("marketplace endpoints normalize products, persist offers, and generate mock-only links", async () => {
  // Build services explicitly to make this test's mock registration unambiguous.
  const registry = new MarketplaceProviderRegistry();
  registry.register(new MockMarketplaceProvider([{ externalProductId: "sku-1", name: "Test kettle", category: "kitchen", priceCents: 4299, currency: "USD", productUrl: "https://catalog.example.test/products/sku-1", availability: "in_stock" }], { "sku-1": [{ externalOfferId: "offer-1", priceCents: 4299, currency: "USD", commissionRateBps: 1200, availability: "in_stock" }] }));
  // The service factory accepts a registry; this test uses its public repositories through a fresh factory below.
  const { createServices } = await import("../src/domain/container.js");
  const { InMemoryAffiliateAccountRepository, InMemoryAffiliateOfferRepository, InMemoryMarketplaceConnectionRepository, InMemoryProductCatalogRepository, InMemoryRepository } = await import("../src/domain/repository.js");
  const repos = { affiliates: new InMemoryRepository<any>(), offers: new InMemoryRepository<any>(), conversions: new InMemoryRepository<any>(), commissions: new InMemoryRepository<any>(), marketplaceConnections: new InMemoryMarketplaceConnectionRepository(), affiliateAccounts: new InMemoryAffiliateAccountRepository(), products: new InMemoryProductCatalogRepository(), affiliateOffers: new InMemoryAffiliateOfferRepository() };
  await repos.marketplaceConnections.save(connection);
  const configured = createServices(repos, { run: (work) => work({ conversions: repos.conversions, commissions: repos.commissions }) }, registry);
  const app = createApp(configured);
  const discover = await app.inject({ method: "POST", url: "/api/v1/marketplaces/test-catalog/products/discover" });
  assert.equal(discover.statusCode, 200);
  assert.equal(discover.json().data[0].name, "Test kettle");
  const link = await app.inject({ method: "POST", url: "/api/v1/marketplaces/test-catalog/products/sku-1/offers/offer-1/affiliate-link" });
  assert.equal(link.statusCode, 200);
  assert.equal(link.json().affiliateLinkStatus, "active");
  assert.match(link.json().affiliateUrl, /^https:\/\/mock-marketplace\.invalid\//);
  await app.close();
});

test("marketplace provider numeric overflow is rejected before persistence", async () => {
  const registry = new MarketplaceProviderRegistry();
  registry.register(new MockMarketplaceProvider([{ externalProductId: "sku-overflow", name: "Unsafe product", priceCents: Number.MAX_SAFE_INTEGER + 2, currency: "USD", productUrl: "https://catalog.example.test/products/unsafe", availability: "in_stock" }], { "sku-overflow": [{ externalOfferId: "offer-overflow", priceCents: 100, currency: "USD", commissionRateBps: 1200, availability: "in_stock" }] }));
  const { createServices } = await import("../src/domain/container.js");
  const { InMemoryAffiliateAccountRepository, InMemoryAffiliateOfferRepository, InMemoryMarketplaceConnectionRepository, InMemoryProductCatalogRepository, InMemoryRepository } = await import("../src/domain/repository.js");
  const repos = { affiliates: new InMemoryRepository<any>(), offers: new InMemoryRepository<any>(), conversions: new InMemoryRepository<any>(), commissions: new InMemoryRepository<any>(), marketplaceConnections: new InMemoryMarketplaceConnectionRepository(), affiliateAccounts: new InMemoryAffiliateAccountRepository(), products: new InMemoryProductCatalogRepository(), affiliateOffers: new InMemoryAffiliateOfferRepository() };
  await repos.marketplaceConnections.save({ ...connection, slug: "overflow-catalog" });
  const configured = createServices(repos, { run: (work) => work({ conversions: repos.conversions, commissions: repos.commissions }) }, registry);
  const app = createApp(configured);
  const response = await app.inject({ method: "POST", url: "/api/v1/marketplaces/overflow-catalog/products/discover" });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "INVALID_MARKETPLACE_NUMERIC_VALUE");
  assert.equal((await repos.products.list()).length, 0);
  await app.close();
});

test("unconfigured marketplace never impersonates a connected provider", async () => {
  const app = createApp();
  const response = await app.inject({ method: "POST", url: "/api/v1/marketplaces/not-real/products/discover" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "MARKETPLACE_NOT_CONFIGURED");
  await app.close();
});
