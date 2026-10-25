import assert from "node:assert/strict";
import test from "node:test";
import { MarketplaceProviderRegistry } from "../src/domain/foundations.js";
import { MarketplaceService } from "../src/domain/marketplace.js";
import {
  InMemoryAffiliateAccountRepository,
  InMemoryAffiliateOfferRepository,
  InMemoryMarketplaceConnectionRepository,
  InMemoryProductCatalogRepository,
  InMemoryRepository
} from "../src/domain/repository.js";
import type { Affiliate } from "@affiliateos/shared";

function setup() {
  const connections = new InMemoryMarketplaceConnectionRepository();
  const products = new InMemoryProductCatalogRepository();
  const accounts = new InMemoryAffiliateAccountRepository();
  const affiliates = new InMemoryRepository<Affiliate>();
  const offers = new InMemoryAffiliateOfferRepository();
  const conversionOffers = new InMemoryRepository<import("@affiliateos/shared").Offer>();
  const service = new MarketplaceService(
    new MarketplaceProviderRegistry(),
    connections,
    products,
    accounts,
    affiliates,
    offers,
    conversionOffers
  );
  return { service, connections, products, accounts, affiliates, offers };
}

function makeItems(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const id = String(index + 1).padStart(4, "0");
    return {
      externalProductId: `resilience-${id}`,
      name: `Shopee resilience product ${id}`,
      priceCents: 100_000,
      currency: "IDR",
      productUrl: `https://shopee.co.id/product/1/${id}`,
      affiliateUrl: `https://s.shopee.co.id/resilience-${id}`,
      availability: "in_stock" as const,
      commissionRateBps: 500,
      commissionAmountCents: 500
    };
  });
}

const affiliateId = "00000000-0000-4000-8000-000000000601";

test("Shopee feed import handles 1,000 rows and remains idempotent on retry", async () => {
  const state = setup();
  await state.affiliates.save({
    id: affiliateId,
    name: "CSV resilience test",
    email: "csv-resilience@example.test",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z"
  });

  const request = {
    affiliateId,
    sourceReference: "csv-resilience-regression-test",
    items: makeItems(1_000)
  };

  const first = await state.service.importShopeeAffiliateFeed(request);
  const second = await state.service.importShopeeAffiliateFeed(request);

  assert.equal(first.importedProducts, 1_000);
  assert.equal(first.importedOffers, 1_000);
  assert.equal(first.skippedItems, 0);
  assert.equal(second.importedProducts, 1_000);
  assert.equal(second.importedOffers, 1_000);
  assert.equal((await state.products.list()).length, 1_000);
  assert.equal((await state.offers.list()).length, 1_000);
  assert.deepEqual(second.affiliateOfferIds, first.affiliateOfferIds);
  assert.equal(new Set(first.affiliateOfferIds).size, 1_000);
});

test("invalid Shopee batch is rejected before any import records are written", async () => {
  const state = setup();
  await state.affiliates.save({
    id: affiliateId,
    name: "CSV validation test",
    email: "csv-validation@example.test",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z"
  });

  const items = makeItems(20);
  items[10] = {
    ...items[10]!,
    commissionAmountCents: items[10]!.priceCents + 1
  };

  await assert.rejects(
    state.service.importShopeeAffiliateFeed({ affiliateId, items }),
    /Commission amount cannot exceed price/
  );

  assert.equal((await state.connections.list()).length, 0);
  assert.equal((await state.accounts.list()).length, 0);
  assert.equal((await state.products.list()).length, 0);
  assert.equal((await state.offers.list()).length, 0);
});
