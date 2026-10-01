import assert from "node:assert/strict";
import test from "node:test";
import type { Affiliate, AffiliateOffer, Commission, Offer } from "@affiliateos/shared";
import { InMemoryAffiliateOfferRepository, InMemoryConversionRepository, InMemoryRepository, type TransactionManager } from "../../src/domain/repository.js";
import { ConversionService } from "../../src/domain/services.js";
import { ProviderConversionProcessor } from "../../src/domain/provider-conversion-processor.js";
import type { NormalizedProviderConversion } from "../../src/domain/provider-conversion.js";

const event: NormalizedProviderConversion = {
  externalConversionId: "conv_300",
  affiliateReference: "aff_300",
  offerReference: "offer_300",
  amountCents: 2500,
  currency: "USD",
  occurredAt: "2026-09-20T10:00:00.000Z",
  status: "pending",
  sourceEventId: "evt_300",
  rawEventType: "conversion.created"
};

test("processes a normalized provider conversion through the existing idempotent conversion service", async () => {
  const services = createInMemoryServices();
  const affiliate = await services.affiliates.create({ name: "Provider affiliate", email: "provider@example.com" });
  const offer = await services.offers.create({ name: "Provider offer", status: "active", commissionRateBps: 1000 });
  const processor = new ProviderConversionProcessor(services.conversions, {
    resolveAffiliate: async (reference) => reference === "aff_300" ? affiliate.id : undefined,
    resolveOffer: async (reference) => reference === "offer_300" ? offer.id : undefined
  });

  const first = await processor.process("account-a", event);
  const second = await processor.process("account-a", event);
  assert.equal(first.id, second.id);
  assert.equal((await services.conversions.list()).length, 1);
  assert.equal((await services.commissions.list()).length, 1);
});

test("keeps identical external conversion IDs isolated by provider account scope", async () => {
  const services = createInMemoryServices();
  const affiliate = await services.affiliates.create({ name: "Provider affiliate", email: "provider-2@example.com" });
  const offer = await services.offers.create({ name: "Provider offer", status: "active", commissionRateBps: 1000 });
  const processor = new ProviderConversionProcessor(services.conversions, {
    resolveAffiliate: async () => affiliate.id,
    resolveOffer: async () => offer.id
  });
  const first = await processor.process("account-a", event);
  const second = await processor.process("account-b", event);
  assert.notEqual(first.id, second.id);
  assert.equal((await services.conversions.list()).length, 2);
});

test("fails closed when provider references cannot be resolved", async () => {
  const services = createInMemoryServices();
  const processor = new ProviderConversionProcessor(services.conversions, {
    resolveAffiliate: async () => undefined,
    resolveOffer: async () => undefined
  });
  await assert.rejects(() => processor.process("account-a", event), { code: "PROVIDER_CONVERSION_AFFILIATE_UNKNOWN" });
});

test("resolves marketplace conversions from tracking references and preserves affiliate offer identity", async () => {
  const affiliates = new InMemoryRepository<Affiliate>();
  const offers = new InMemoryRepository<Offer>();
  const conversions = new InMemoryConversionRepository();
  const commissions = new InMemoryRepository<Commission>();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const transactionManager: TransactionManager = {
    run: (work) => work({ conversions, commissions })
  };
  const conversionService = new ConversionService(conversions, commissions, affiliates, offers, affiliateOffers, transactionManager);
  const affiliate = {
    id: "00000000-0000-4000-8000-000000000390",
    name: "Marketplace affiliate",
    email: "marketplace@example.com",
    status: "active" as const,
    createdAt: "2026-09-20T10:00:00.000Z"
  };
  const offer = {
    id: "00000000-0000-4000-8000-000000000391",
    name: "Marketplace program",
    status: "active" as const,
    commissionRateBps: 0,
    createdAt: "2026-09-20T10:00:00.000Z"
  };
  const affiliateOfferId = "00000000-0000-4000-8000-000000000399";
  const trackingLinkId = "00000000-0000-4000-8000-000000000398";
  const affiliateOffer: AffiliateOffer = {
    id: affiliateOfferId,
    productId: "00000000-0000-4000-8000-000000000397",
    conversionOfferId: offer.id,
    affiliateAccountId: "00000000-0000-4000-8000-000000000396",
    externalOfferId: "offer-399",
    priceCents: 4999,
    currency: "USD",
    commissionRateBps: 1200,
    availability: "in_stock",
    availabilityMetadata: {},
    affiliateLinkStatus: "active",
    status: "active",
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z"
  };
  await affiliates.save(affiliate);
  await offers.save(offer);
  await affiliateOffers.save(affiliateOffer);

  let attributed: { conversionId: string; trackingLinkId: string } | undefined;
  const processor = new ProviderConversionProcessor(conversionService, {
    resolveAffiliate: async () => undefined,
    resolveOffer: async () => undefined,
    resolveTracking: async (accountScope, reference) => accountScope === "account-shopee" && reference === "track-399"
      ? { affiliateId: affiliate.id, offerId: offer.id, affiliateOfferId, trackingLinkId }
      : undefined
  }, {
    attribute: async (conversionId, linkId) => { attributed = { conversionId, trackingLinkId: linkId }; }
  });

  const conversion = await processor.process("account-shopee", {
    externalConversionId: "shopee-conv-399",
    trackingReference: "track-399",
    amountCents: 4999,
    occurredAt: "2026-09-20T10:00:00.000Z",
    status: "approved",
    commissionCents: 600,
    sourceEventId: "shopee-report-399",
    rawEventType: "conversion.report"
  });

  assert.equal(conversion.affiliateId, affiliate.id);
  assert.equal(conversion.offerId, offer.id);
  assert.equal(conversion.affiliateOfferId, affiliateOfferId);
  assert.deepEqual(attributed, { conversionId: conversion.id, trackingLinkId });
  assert.equal((await commissions.list()).length, 1);
  assert.equal((await commissions.list())[0]?.amountCents, 600);
});
