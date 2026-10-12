import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ImportShopeeAffiliateFeedRequest } from "@affiliateos/shared";
import type { MarketplaceService } from "../../src/domain/marketplace.js";
import { InMemoryAutonomousCycleLock } from "../../src/domain/autonomous-cycle-lock.js";
import { ShopeeAffiliateFeedIngestionScheduler, type ShopeeAffiliateFeedSource } from "../../src/domain/shopee-affiliate-feed-ingestion-scheduler.js";

const feed: ImportShopeeAffiliateFeedRequest = {
  affiliateId: "affiliate-1",
  sourceReference: "official-feed-reference",
  items: [{
    externalProductId: "product-1",
    externalOfferId: "offer-1",
    name: "Product",
    priceCents: 10000,
    currency: "IDR",
    productUrl: "https://shopee.co.id/product-1",
    affiliateUrl: "https://s.shopee.co.id/offer-1",
    availability: "in_stock"
  }]
};

describe("ShopeeAffiliateFeedIngestionScheduler", () => {
  it("fetches from the injected feed source and imports it", async () => {
    const calls: ImportShopeeAffiliateFeedRequest[] = [];
    const marketplace = {
      importShopeeAffiliateFeed: async (input: ImportShopeeAffiliateFeedRequest) => {
        calls.push(input);
        return { connection: {} as never, importedProducts: 1, importedOffers: 1, skippedItems: 0, affiliateOfferIds: ["offer-1"] };
      }
    } as unknown as MarketplaceService;
    const source: ShopeeAffiliateFeedSource = { fetch: async () => feed };
    const scheduler = new ShopeeAffiliateFeedIngestionScheduler(marketplace, source, new InMemoryAutonomousCycleLock(), {
      intervalMs: 900_000,
      now: () => new Date("2026-10-12T06:00:00.000Z")
    });

    const result = await scheduler.runNow();

    assert.equal(result.imported, true);
    assert.equal(result.result?.importedProducts, 1);
    assert.deepEqual(calls, [feed]);
    assert.equal(scheduler.status.lastCompletedAt, "2026-10-12T06:00:00.000Z");
  });

  it("does not import when another scheduler holds the ingestion lock", async () => {
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const marketplace = {
      importShopeeAffiliateFeed: async () => {
        calls += 1;
        await blocked;
        return { connection: {} as never, importedProducts: 1, importedOffers: 1, skippedItems: 0, affiliateOfferIds: ["offer-1"] };
      }
    } as unknown as MarketplaceService;
    const source: ShopeeAffiliateFeedSource = { fetch: async () => feed };
    const lock = new InMemoryAutonomousCycleLock();
    const first = new ShopeeAffiliateFeedIngestionScheduler(marketplace, source, lock, { intervalMs: 900_000 });
    const second = new ShopeeAffiliateFeedIngestionScheduler(marketplace, source, lock, { intervalMs: 900_000 });

    const firstRun = first.runNow();
    await new Promise((resolve) => setImmediate(resolve));
    const secondRun = await second.runNow();
    assert.equal(secondRun.imported, false);
    assert.equal(calls, 1);
    release();
    await firstRun;
  });

  it("rejects an interval below 15 minutes", () => {
    const marketplace = {} as MarketplaceService;
    const source = {} as ShopeeAffiliateFeedSource;
    const lock = new InMemoryAutonomousCycleLock();
    assert.throws(
      () => new ShopeeAffiliateFeedIngestionScheduler(marketplace, source, lock, { intervalMs: 899_999 }),
      /at least 15 minutes/
    );
  });
});
