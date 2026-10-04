import assert from "node:assert/strict";
import test from "node:test";
import { ShopeeCommissionReportReconciliationService } from "../src/domain/shopee-commission-report-reconciliation.js";

test("ShopeeCommissionReportReconciliationService maps commission report rows into provider conversions using stable idempotency keys", async () => {
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

  assert.deepEqual(result, {
    sourceReference: "commission-period-2026-10-01",
    processed: 1,
    failed: 0,
    failures: []
  });
  assert.deepEqual(processed, [{
    accountScope: "account-1",
    externalConversionId: "report:50ac93f41009bb5828fbeb9b39ca5129a5888ba493196a343d69c38b2df5a412"
  }]);
});

test("ShopeeCommissionReportReconciliationService keeps row failures isolated from successful rows", async () => {
  const marketplace = {
    getAffiliateAccount: async () => ({ id: "account-1", affiliateId: "affiliate-1" })
  } as any;
  const providerConversions = {
    process: async (_accountScope: string, event: any) => {
      if (event.trackingReference === "unknown") throw new Error("tracking reference could not be resolved");
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

  assert.equal(result.processed, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failures[0], { rowKey: "bad", error: "tracking reference could not be resolved" });
});
test("ShopeeCommissionReportReconciliationService keeps fallback conversion identity stable across report periods", async () => {
  const externalIds: string[] = [];
  const marketplace = { getAffiliateAccount: async () => ({ id: "account-1", affiliateId: "affiliate-1" }) } as any;
  const providerConversions = {
    process: async (_accountScope: string, event: any) => {
      externalIds.push(event.externalConversionId);
      return { id: "conversion-1", affiliateId: "affiliate-1", offerId: "offer-1", amountCents: event.amountCents, status: event.status, occurredAt: event.occurredAt };
    }
  } as any;
  const service = new ShopeeCommissionReportReconciliationService(marketplace, providerConversions);
  const row = { rowKey: "order-2001", trackingReference: "sub-2001", amountCents: 5000, commissionCents: 500, occurredAt: "2026-10-01T08:00:00.000Z", status: "approved" as const };
  await service.reconcile("shopee-affiliate-feed", { sourceReference: "period-a", rows: [row] });
  await service.reconcile("shopee-affiliate-feed", { sourceReference: "period-b", rows: [row] });
  assert.equal(externalIds.length, 2);
  assert.equal(externalIds[0], externalIds[1]);
});
