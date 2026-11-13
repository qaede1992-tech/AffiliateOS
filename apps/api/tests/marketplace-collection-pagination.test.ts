import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { MarketplaceProviderRegistry } from "../src/domain/foundations.js";
import { createServices } from "../src/domain/container.js";
import {
  InMemoryAffiliateAccountRepository,
  InMemoryAffiliateOfferRepository,
  InMemoryMarketplaceConnectionRepository,
  InMemoryProductCatalogRepository,
  InMemoryRepository
} from "../src/domain/repository.js";

const marketplaceId = "00000000-0000-4000-8000-000000000011";
const affiliateAccountId = "00000000-0000-4000-8000-000000000012";
const connection = {
  id: marketplaceId, name: "Test catalog", slug: "test-catalog", providerSlug: "mock", connectionMode: "mock" as const,
  status: "active" as const, enabled: true, configuration: {}, healthStatus: "healthy" as const, healthMetadata: {},
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
};

test("product and affiliate-offer collection endpoints return bounded, stable cursor pages", async () => {
  const repos = {
    affiliates: new InMemoryRepository<any>(),
    offers: new InMemoryRepository<any>(),
    conversions: new InMemoryRepository<any>(),
    commissions: new InMemoryRepository<any>(),
    marketplaceConnections: new InMemoryMarketplaceConnectionRepository(),
    affiliateAccounts: new InMemoryAffiliateAccountRepository(),
    products: new InMemoryProductCatalogRepository(),
    affiliateOffers: new InMemoryAffiliateOfferRepository()
  };
  await repos.marketplaceConnections.save(connection);
  const createdAt = "2026-01-01T00:00:00.000Z";
  const products = [
    { id: "00000000-0000-4000-8000-000000000101", marketplaceId, externalProductId: "sku-a", name: "Alpha kettle", priceCents: 1000, currency: "IDR", productUrl: "https://catalog.example.test/a", status: "active" as const, createdAt, updatedAt: createdAt },
    { id: "00000000-0000-4000-8000-000000000102", marketplaceId, externalProductId: "sku-b", name: "Beta lamp", priceCents: 2000, currency: "IDR", productUrl: "https://catalog.example.test/b", status: "active" as const, createdAt, updatedAt: createdAt },
    { id: "00000000-0000-4000-8000-000000000103", marketplaceId, externalProductId: "sku-c", name: "Gamma kettle", priceCents: 3000, currency: "IDR", productUrl: "https://catalog.example.test/c", status: "active" as const, createdAt, updatedAt: createdAt }
  ];
  for (const product of products) await repos.products.save(product);
  for (let index = 0; index < 3; index++) {
    await repos.affiliateOffers.save({
      id: `00000000-0000-4000-8000-00000000020${index + 1}`,
      productId: products[index]!.id,
      affiliateAccountId,
      externalOfferId: `offer-${index + 1}`,
      priceCents: 1000 + index,
      currency: "IDR",
      commissionRateBps: 1000,
      availability: "in_stock",
      availabilityMetadata: {},
      affiliateLinkStatus: "not_generated",
      status: "active",
      createdAt,
      updatedAt: createdAt
    });
  }
  const services = createServices(repos, { run: (work: any) => work({ conversions: repos.conversions, commissions: repos.commissions }) }, new MarketplaceProviderRegistry());
  const app = createApp(services);
  try {
    const firstProducts = await app.inject({ method: "GET", url: "/api/v1/products/page?limit=2" });
    assert.equal(firstProducts.statusCode, 200);
    assert.equal(firstProducts.json().data.length, 2);
    assert.equal(firstProducts.json().hasMore, true);
    const secondProducts = await app.inject({ method: "GET", url: `/api/v1/products/page?limit=2&cursor=${encodeURIComponent(firstProducts.json().nextCursor)}` });
    assert.equal(secondProducts.statusCode, 200);
    assert.equal(secondProducts.json().data.length, 1);
    assert.equal(new Set([...firstProducts.json().data, ...secondProducts.json().data].map((row: { id: string }) => row.id)).size, 3);

    const filteredProducts = await app.inject({ method: "GET", url: "/api/v1/products/page?query=kettle&limit=10" });
    assert.equal(filteredProducts.statusCode, 200);
    assert.deepEqual(filteredProducts.json().data.map((row: { externalProductId: string }) => row.externalProductId), ["sku-a", "sku-c"]);

    const firstOffers = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers/page?limit=2" });
    assert.equal(firstOffers.statusCode, 200);
    assert.equal(firstOffers.json().data.length, 2);
    assert.equal(firstOffers.json().hasMore, true);
    const secondOffers = await app.inject({ method: "GET", url: `/api/v1/affiliate-offers/page?limit=2&cursor=${encodeURIComponent(firstOffers.json().nextCursor)}` });
    assert.equal(secondOffers.statusCode, 200);
    assert.equal(secondOffers.json().data.length, 1);
    assert.equal(new Set([...firstOffers.json().data, ...secondOffers.json().data].map((row: { id: string }) => row.id)).size, 3);

    const invalidCursor = await app.inject({ method: "GET", url: "/api/v1/products/page?cursor=not-a-cursor" });
    assert.equal(invalidCursor.statusCode, 400);
    const oversizedPage = await app.inject({ method: "GET", url: "/api/v1/affiliate-offers/page?limit=51" });
    assert.equal(oversizedPage.statusCode, 400);
  } finally {
    await app.close();
  }
});
