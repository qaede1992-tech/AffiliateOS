import assert from "node:assert/strict";
import test from "node:test";
import { ShopeeCommissionReportReconciliationService } from "../src/domain/shopee-commission-report-reconciliation.js";
import type { Affiliate, AffiliateOffer, Offer } from "@affiliateos/shared";
import { ConversionService } from "../src/domain/services.js";
import { InMemoryAffiliateOfferRepository, InMemoryCommissionRepository, InMemoryConversionRepository, InMemoryRepository } from "../src/domain/repository.js";
import { ProviderConversionProcessor } from "../src/domain/provider-conversion-processor.js";


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


test("ShopeeCommissionReportReconciliationService is idempotent when the same report row is replayed", async () => {
  const affiliate: Affiliate = { id: "00000000-0000-4000-8000-000000000501", name: "Shopee affiliate", email: "shopee@example.com", status: "active", createdAt: "2026-10-01T08:00:00.000Z" };
  const offer: Offer = { id: "00000000-0000-4000-8000-000000000502", name: "Shopee program", status: "active", commissionRateBps: 1000, createdAt: "2026-10-01T08:00:00.000Z" };
  const affiliateOffer: AffiliateOffer = {
    id: "00000000-0000-4000-8000-000000000503",
    productId: "00000000-0000-4000-8000-000000000504",
    conversionOfferId: offer.id,
    affiliateAccountId: "00000000-0000-4000-8000-000000000505",
    externalOfferId: "shopee-offer-501",
    priceCents: 125000,
    currency: "IDR",
    commissionRateBps: 760,
    availability: "in_stock",
    availabilityMetadata: {},
    affiliateLinkStatus: "active",
    status: "active",
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z"
  };
  const conversions = new InMemoryConversionRepository();
  const commissions = new InMemoryCommissionRepository();
  const affiliates = new InMemoryRepository<Affiliate>();
  const offers = new InMemoryRepository<Offer>();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  await affiliates.save(affiliate);
  await offers.save(offer);
  await affiliateOffers.save(affiliateOffer);
  const conversionService = new ConversionService(conversions, commissions, affiliates, offers, affiliateOffers, {
    run: (work) => work({ conversions, commissions })
  });
  const processor = new ProviderConversionProcessor(conversionService, {
    resolveAffiliate: async () => undefined,
    resolveOffer: async () => undefined,
    resolveTracking: async (accountScope, reference) => accountScope === affiliateOffer.affiliateAccountId && reference === "sub-501"
      ? { affiliateId: affiliate.id, offerId: offer.id, affiliateOfferId: affiliateOffer.id, trackingLinkId: "00000000-0000-4000-8000-000000000506" }
      : undefined
  });
  const marketplace = {
    getAffiliateAccount: async () => ({ id: affiliateOffer.affiliateAccountId, affiliateId: affiliate.id })
  } as any;
  const service = new ShopeeCommissionReportReconciliationService(marketplace, processor);
  const input = {
    sourceReference: "commission-period-2026-10-04",
    rows: [{ rowKey: "order-501", trackingReference: "sub-501", amountCents: 1250000, commissionCents: 95000, occurredAt: "2026-10-04T08:00:00.000Z", status: "approved" as const }]
  };

  const first = await service.reconcile("shopee-affiliate-feed", input);
  const second = await service.reconcile("shopee-affiliate-feed", input);

  assert.deepEqual(first, { sourceReference: input.sourceReference, processed: 1, failed: 0, failures: [] });
  assert.deepEqual(second, first);
  assert.equal((await conversions.list()).length, 1);
  assert.equal((await commissions.list()).length, 1);
  assert.equal((await commissions.list())[0]?.amountCents, 95000);
  assert.equal((await conversions.list())[0]?.status, "approved");
});


test("ShopeeCommissionReportReconciliationService rejects a missing source reference", async () => {
  const service = new ShopeeCommissionReportReconciliationService(
    { getAffiliateAccount: async () => ({ id: "account-1", affiliateId: "affiliate-1" }) } as any,
    { process: async () => { throw new Error("should not process"); } } as any
  );

  await assert.rejects(
    () => service.reconcile("shopee-affiliate-feed", {
      sourceReference: "   ",
      rows: []
    }),
    (error: any) => error?.code === "SHOPEE_REPORT_SOURCE_MISSING" && error?.statusCode === 422
  );
});

test("ShopeeCommissionReportReconciliationService rejects an empty row key without processing it", async () => {
  let processed = 0;
  const service = new ShopeeCommissionReportReconciliationService(
    { getAffiliateAccount: async () => ({ id: "account-1", affiliateId: "affiliate-1" }) } as any,
    { process: async () => { processed += 1; } } as any
  );

  const result = await service.reconcile("shopee-affiliate-feed", {
    sourceReference: "period-1",
    rows: [{
      rowKey: "   ",
      trackingReference: "sub-1",
      amountCents: 1000,
      occurredAt: "2026-10-01T08:00:00.000Z"
    }]
  });

  assert.equal(processed, 0);
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failures, [{
    rowKey: "   ",
    error: "Shopee commission report row key is required."
  }]);
});

test("ShopeeCommissionReportReconciliationService trims identity fields before deriving fallback conversion IDs", async () => {
  const externalIds: string[] = [];
  const service = new ShopeeCommissionReportReconciliationService(
    { getAffiliateAccount: async () => ({ id: "account-1", affiliateId: "affiliate-1" }) } as any,
    {
      process: async (_accountScope: string, event: any) => {
        externalIds.push(event.externalConversionId);
      }
    } as any
  );

  const result = await service.reconcile("  shopee-affiliate-feed  ", {
    sourceReference: "  period-1  ",
    rows: [{
      rowKey: "  order-1  ",
      trackingReference: "sub-1",
      amountCents: 1000,
      occurredAt: "2026-10-01T08:00:00.000Z"
    }]
  });

  assert.equal(result.sourceReference, "period-1");
  assert.equal(result.processed, 1);
  assert.deepEqual(externalIds, ["report:28e95c0f6d4e2f8d3b0f7e7d6f0f7c7c6c8f0d2e5b4c4c1c7c5e0b3d8e2a9a1"]);
});
