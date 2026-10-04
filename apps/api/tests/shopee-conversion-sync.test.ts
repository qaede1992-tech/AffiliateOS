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
  const conversions = { findByIdempotencyKey: async () => undefined };
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
  const conversions = { findByIdempotencyKey: async () => undefined };
  const service = new ShopeeConversionSyncService(marketplace as never, conversions as never, processor as never);
  assert.deepEqual(await service.sync("shopee-id", "2026-09-25T00:00:00.000Z"), { fetched: 1, created: 0, alreadyProcessed: 0, skippedUnattributed: 1, failed: 0 });
});


test("Shopee conversion sync counts an idempotent replay as already processed", async () => {
  const provider = {
    slug: "shopee-affiliate",
    conversionReportDetailed: async () => [{
      conversionId: "conv-replay",
      purchaseTime: "2026-09-25T10:00:00.000Z",
      netCommissionCents: 1100,
      utmContent: "trk-replay",
      orders: [{ orderId: "order-replay", orderStatus: "COMPLETED", items: [{ itemId: "item-replay", actualAmountCents: 5000, qty: 1 }] }]
    }]
  };
  const marketplace = { getProviderForSync: async () => ({ account: { id: "account-1" }, provider }) };
  const processor = { process: async () => ({ id: "internal-replay" }) };
  const conversions = {
    findByIdempotencyKey: async (key: string) => key === "provider:account-1:conv-replay"
      ? { id: "internal-replay" }
      : undefined
  };
  const service = new ShopeeConversionSyncService(marketplace as never, conversions as never, processor as never);

  assert.deepEqual(
    await service.sync("shopee-id", "2026-09-25T00:00:00.000Z"),
    { fetched: 1, created: 0, alreadyProcessed: 1, skippedUnattributed: 0, failed: 0 }
  );
});

test("Shopee conversion sync does not inflate zero-quantity report items", async () => {
  let captured: Record<string, unknown> | undefined;
  const provider = {
    slug: "shopee-affiliate",
    conversionReportDetailed: async () => [{
      conversionId: "conv-zero-qty",
      purchaseTime: "2026-09-25T10:00:00.000Z",
      netCommissionCents: 0,
      utmContent: "trk-zero-qty",
      orders: [{ orderId: "order-zero-qty", orderStatus: "COMPLETED", items: [{ itemId: "item-zero-qty", actualAmountCents: 5000, qty: 0 }] }]
    }]
  };
  const marketplace = { getProviderForSync: async () => ({ account: { id: "account-1" }, provider }) };
  const processor = { process: async (_scope: string, event: Record<string, unknown>) => { captured = event; return { id: "internal-zero-qty" }; } };
  const conversions = { findByIdempotencyKey: async () => undefined };
  const service = new ShopeeConversionSyncService(marketplace as never, conversions as never, processor as never);

  await service.sync("shopee-id", "2026-09-25T00:00:00.000Z");

  assert.equal(captured?.amountCents, 0);
});
