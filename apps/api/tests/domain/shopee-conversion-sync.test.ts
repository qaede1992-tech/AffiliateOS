import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShopeeConversionSyncService } from "../../src/domain/shopee-conversion-sync.js";

describe("ShopeeConversionSyncService", () => {
  it("fails closed when the aggregated order amount exceeds Number.MAX_SAFE_INTEGER", async () => {
    let processed = false;
    const service = new ShopeeConversionSyncService(
      {
        getProviderForSync: async () => ({
          account: { id: "account-1" },
          provider: {
            slug: "shopee-affiliate",
            conversionReportDetailed: async () => [{
              conversionId: "conversion-overflow",
              purchaseTime: "2026-09-30T00:00:00.000Z",
              utmContent: "tracking-code",
              orders: [{
                orderId: "order-1",
                items: [{
                  itemId: "item-1",
                  actualAmountCents: Number.MAX_SAFE_INTEGER,
                  qty: 2
                }]
              }]
            }]
          }
        })
      } as never,
      {
        findByIdempotencyKey: async () => undefined
      } as never,
      {
        process: async () => {
          processed = true;
          throw new Error("processor should not be called for an unsafe amount");
        }
      } as never
    );

    const result = await service.sync("shopee-id", "2026-09-29T00:00:00.000Z");

    assert.equal(result.fetched, 1);
    assert.equal(result.created, 0);
    assert.equal(result.alreadyProcessed, 0);
    assert.equal(result.skippedUnattributed, 0);
    assert.equal(result.failed, 1);
    assert.equal(processed, false);
  });
});
