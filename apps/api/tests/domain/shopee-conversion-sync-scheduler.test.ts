import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MarketplaceService } from "../../src/domain/marketplace.js";
import type { MarketplaceConversionSyncResult, ShopeeConversionSyncService } from "../../src/domain/shopee-conversion-sync.js";
import { InMemoryAutonomousCycleLock } from "../../src/domain/autonomous-cycle-lock.js";
import { ShopeeConversionSyncScheduler } from "../../src/domain/shopee-conversion-sync-scheduler.js";

const syncResult: MarketplaceConversionSyncResult = {
  fetched: 2,
  created: 1,
  alreadyProcessed: 1,
  skippedUnattributed: 0,
  failed: 0
};

describe("ShopeeConversionSyncScheduler", () => {
  it("syncs active Shopee connections over a rolling lookback window", async () => {
    const calls: Array<{ slug: string; since: string }> = [];
    const marketplace = {
      listConnections: async () => [
        { slug: "shopee-id", providerSlug: "shopee-affiliate", enabled: true, status: "active" },
        { slug: "disabled", providerSlug: "shopee-affiliate", enabled: false, status: "active" },
        { slug: "other", providerSlug: "other", enabled: true, status: "active" }
      ]
    } as unknown as MarketplaceService;
    const syncService = {
      sync: async (slug: string, since: string) => {
        calls.push({ slug, since });
        return syncResult;
      }
    } as unknown as ShopeeConversionSyncService;
    const scheduler = new ShopeeConversionSyncScheduler(marketplace, syncService, new InMemoryAutonomousCycleLock(), {
      intervalMs: 300_000,
      lookbackHours: 24,
      now: () => new Date("2026-09-26T06:00:00.000Z")
    });

    const result = await scheduler.runNow();

    assert.equal(result.locked, true);
    assert.equal(result.attemptedConnections, 1);
    assert.equal(result.fetched, 2);
    assert.equal(result.created, 1);
    assert.equal(result.alreadyProcessed, 1);
    assert.deepEqual(calls, [{ slug: "shopee-id", since: "2026-09-25T06:00:00.000Z" }]);
  });

  it("prevents concurrent schedulers from executing the same sync", async () => {
    let calls = 0;
    const marketplace = { listConnections: async () => [{ slug: "shopee-id", providerSlug: "shopee-affiliate", enabled: true, status: "active" }] } as unknown as MarketplaceService;
    const syncService = {
      sync: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return syncResult;
      }
    } as unknown as ShopeeConversionSyncService;
    const lock = new InMemoryAutonomousCycleLock();
    const first = new ShopeeConversionSyncScheduler(marketplace, syncService, lock, { intervalMs: 300_000 });
    const second = new ShopeeConversionSyncScheduler(marketplace, syncService, lock, { intervalMs: 300_000 });

    const [one, two] = await Promise.all([first.runNow(), second.runNow()]);

    assert.equal(calls, 1);
    assert.equal(one.locked !== two.locked, true);
  });

  it("does not overlap runs within one scheduler instance", async () => {
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const marketplace = { listConnections: async () => [{ slug: "shopee-id", providerSlug: "shopee-affiliate", enabled: true, status: "active" }] } as unknown as MarketplaceService;
    const syncService = {
      sync: async () => {
        calls += 1;
        await blocked;
        return syncResult;
      }
    } as unknown as ShopeeConversionSyncService;
    const scheduler = new ShopeeConversionSyncScheduler(marketplace, syncService, new InMemoryAutonomousCycleLock(), { intervalMs: 300_000 });
    const first = scheduler.runNow();
    const second = scheduler.runNow();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    assert.equal(await first, await second);
  });

  it("rejects unsafe scheduler settings", () => {
    const marketplace = {} as MarketplaceService;
    const syncService = {} as ShopeeConversionSyncService;
    const lock = new InMemoryAutonomousCycleLock();
    assert.throws(() => new ShopeeConversionSyncScheduler(marketplace, syncService, lock, { intervalMs: 299_999 }), /at least 5 minutes/);
    assert.throws(() => new ShopeeConversionSyncScheduler(marketplace, syncService, lock, { lookbackHours: 31 * 24 + 1 }), /no more than 31 days/);
  });
});
