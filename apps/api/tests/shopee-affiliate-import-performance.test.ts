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

test("Shopee feed import batches 100 products and offers and keeps IDs stable on re-import", async () => {
  const connections = new InMemoryMarketplaceConnectionRepository();
  const products = new InMemoryProductCatalogRepository();
  const accounts = new InMemoryAffiliateAccountRepository();
  const affiliates = new InMemoryRepository<Affiliate>();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const conversionOffers = new InMemoryRepository<import("@affiliateos/shared").Offer>();
  const affiliateId = "00000000-0000-4000-8000-000000000501";
  await affiliates.save({ id: affiliateId, name: "CSV performance test", email: "csv-performance@example.test", status: "active", createdAt: "2026-01-01T00:00:00.000Z" });

  let productBulkCalls = 0;
  let offerLookupBatchCalls = 0;
  let offerBulkCalls = 0;
  const productBulk = products.upsertManyByMarketplaceProduct.bind(products);
  products.upsertManyByMarketplaceProduct = async (entities) => { productBulkCalls += 1; return productBulk(entities); };
  const offerLookupBatch = affiliateOffers.findByAccountOffers.bind(affiliateOffers);
  affiliateOffers.findByAccountOffers = async (accountId, ids) => { offerLookupBatchCalls += 1; return offerLookupBatch(accountId, ids); };
  const offerBulk = affiliateOffers.saveManyById.bind(affiliateOffers);
  affiliateOffers.saveManyById = async (entities) => { offerBulkCalls += 1; return offerBulk(entities); };

  const service = new MarketplaceService(new MarketplaceProviderRegistry(), connections, products, accounts, affiliates, affiliateOffers, conversionOffers);
  const items = Array.from({ length: 100 }, (_, index) => {
    const id = String(index + 1).padStart(3, "0");
    return {
      externalProductId: `csv-perf-${id}`,
      name: `CSV performance product ${id}`,
      priceCents: 100000,
      currency: "IDR",
      productUrl: `https://shopee.co.id/product/csv-perf-${id}`,
      affiliateUrl: `https://shope.ee/csv-perf-${id}`,
      availability: "in_stock" as const,
      commissionRateBps: 500,
      commissionAmountCents: 500
    };
  });
  const request = { affiliateId, sourceReference: "csv-performance-regression-test", items };

  const first = await service.importShopeeAffiliateFeed(request);
  const second = await service.importShopeeAffiliateFeed(request);

  assert.equal(first.importedProducts, 100);
  assert.equal(first.importedOffers, 100);
  assert.equal(first.skippedItems, 0);
  assert.equal(second.importedProducts, 100);
  assert.equal(second.importedOffers, 100);
  assert.equal((await products.list()).length, 100);
  assert.equal((await affiliateOffers.list()).length, 100);
  assert.deepEqual(second.affiliateOfferIds, first.affiliateOfferIds);
  assert.equal(productBulkCalls, 2);
  assert.equal(offerLookupBatchCalls, 2);
  assert.equal(offerBulkCalls, 2);
});
