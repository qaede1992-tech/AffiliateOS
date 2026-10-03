import { describe, expect, it } from "vitest";
import { ShopeeCommissionReportReconciliationService } from "../src/domain/shopee-commission-report-reconciliation.js";

describe("ShopeeCommissionReportReconciliationService", () => {
  it("maps commission report rows into provider conversions using stable idempotency keys", async () => {
    const processed: Array<{ accountScope: string; externalConversionId: string }> = [];
    const marketplace = {
      getAffiliateAccount: async () => ({ id: "account-1", affiliateId: "affiliate-1" })
    } as any;
    const providerConversions = {
      process: async (accountScope: string, event: any) => {
        processed.push({ accountScope, externalConversionId: event.externalConversionId });
        return {
          id: "conversion-1",
          affiliateId: "affiliate-1",
          offerId: "offer-1",
          affiliateOfferId: "affiliate-offer-1",
          amountCents: event.amountCents,
          status: event.status,
          occurredAt: event.occurredAt,
          idempotencyKey: `provider:${accountScope}:${event.externalConversionId}`
        };
      }
    } as any;

    const service = new ShopeeCommissionReportReconciliationService(marketplace, providerConversions);
    const result = await service.reconcile("shopee-affiliate-feed", {
      sourceReference: "commission-period-2026-10-01",
      rows: [{
        rowKey: "order-1001",
        trackingReference: "363e46c5404b",
        amountCents: 12500000,
        commissionCents: 950000,
        occurredAt: "2026-10-01T08:00:00.000Z",
        status: "approved"
      }]
    });

    expect(result).toEqual({
      sourceReference: "commission-period-2026-10-01",
      processed: 1,
      failed: 0,
      failures: []
    });
    expect(processed).toEqual([{
      accountScope: "account-1",
      externalConversionId: "report:403b63f46621c819f1457b194b6a1096a08c91772ea8229545c4554e808de999"
    }]);
  });

  it("keeps row failures isolated from successful rows", async () => {
    const marketplace = {
      getAffiliateAccount: async () => ({ id: "account-1", affiliateId: "affiliate-1" })
    } as any;
    const providerConversions = {
      process: async (_accountScope: string, event: any) => {
        if (event.externalConversionId.endsWith("bad")) throw new Error("tracking reference could not be resolved");
        return {
          id: "conversion-ok",
          affiliateId: "affiliate-1",
          offerId: "offer-1",
          amountCents: event.amountCents,
          status: event.status,
          occurredAt: event.occurredAt,
          idempotencyKey: "provider:account-1:" + event.externalConversionId
        };
      }
    } as any;

    const service = new ShopeeCommissionReportReconciliationService(marketplace, providerConversions);
    const result = await service.reconcile("shopee-affiliate-feed", {
      sourceReference: "period-1",
      rows: [
        { rowKey: "good", trackingReference: "363e46c5404b", amountCents: 1000, occurredAt: "2026-10-01T08:00:00.000Z" },
        { rowKey: "bad", trackingReference: "unknown", amountCents: 1000, occurredAt: "2026-10-01T08:00:00.000Z" }
      ]
    });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures[0]).toEqual({ rowKey: "bad", error: "tracking reference could not be resolved" });
  });
});
