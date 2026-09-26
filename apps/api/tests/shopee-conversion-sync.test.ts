import assert from "node:assert/strict";
import test from "node:test";
import { ShopeeConversionSyncService } from "../src/domain/shopee-conversion-sync.js";

test("Shopee conversion sync processes attributed reports and preserves provider commission", async () => {
  const calls: unknown[] = [];
  const provider = {
    slug: "shopee-affiliate",
    conversionReportDetailed: async () => [{
      conversionId: "conv-1",
      purchaseTime: "2026-09-25T10:00:00.000Z",
      totalCommissionCents: 1200,
      netCommissionCents: 1100,
      utmContent: "trk-1",
      orders: [{ orderId: "order-1", orderStatus: "COMPLETED", items: [{ itemId: "item-1", actualAmountCents: 5000, qty: 2 }] }]
    }]
  };
  const marketplace = { getProviderForSync: async () => ({ account: { id: "account-1" }, provider }) };
  const processor = { process: async (_scope: string, event: Record<string, unknown>) => { calls.push(event); return { id: "internal-1" }; } };
  const conversions = { reconcileProviderState: async (id: string, status: string, commission?: number) => ({ id, status, commission }) };
  const service = new ShopeeConversionSyncService(marketplace as never, conversions as never, processor as never);

  const result = await service.sync("shopee-id", "2026-09-25T00:00:00.000Z");

  assert.deepEqual(result, { fetched: 1, created: 1, alreadyProcessed: 0, skippedUnattributed: 0, failed: 0 });
  assert.deepEqual(calls, [{
    externalConversionId: "conv-1",
    trackingReference: "trk-1",
    amountCents: 10000,
    commissionCents: 1100,
    occurredAt: "2026-09-25T10:00:00.000Z",
    status: "approved",
    sourceEventId: "conv-1",
    rawEventType: "shopee.conversion.report"
  }]);
});

test("Shopee conversion sync skips reports without attribution", async () => {
  const provider = { slug: "shopee-affiliate", conversionReportDetailed: async () => [{
    conversionId: "conv-2", purchaseTime: "2026-09-25T10:00:00.000Z", orders: []
  }] };
  const marketplace = { getProviderForSync: async () => ({ account: { id: "account-1" }, provider }) };
  const processor = { process: async () => { throw new Error("must not process unattributed report"); } };
  const conversions = { reconcileProviderState: async () => undefined };
  const service = new ShopeeConversionSyncService(marketplace as never, conversions as never, processor as never);
  assert.deepEqual(await service.sync("shopee-id", "2026-09-25T00:00:00.000Z"), { fetched: 1, created: 0, alreadyProcessed: 0, skippedUnattributed: 1, failed: 0 });
});
