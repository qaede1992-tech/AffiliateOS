import assert from "node:assert/strict";
import test from "node:test";
import { GenericProviderConversionNormalizer } from "../../src/domain/provider-conversion.js";

const base = {
  eventId: "evt-1",
  eventType: "conversion.created",
  payload: {
    id: "conversion-1",
    affiliateId: "affiliate-1",
    offerId: "offer-1",
    amountCents: 10000,
    currency: "idr",
    occurredAt: "2026-09-20T10:00:00.000Z",
    status: "approved",
    commissionCents: 1000
  }
};

test("normalizes a valid provider conversion", () => {
  const result = new GenericProviderConversionNormalizer().normalize(base);
  assert.equal(result.externalConversionId, "conversion-1");
  assert.equal(result.affiliateReference, "affiliate-1");
  assert.equal(result.offerReference, "offer-1");
  assert.equal(result.amountCents, 10000);
  assert.equal(result.commissionCents, 1000);
  assert.equal(result.currency, "IDR");
  assert.equal(result.rawEventType, "conversion.created");
  assert.equal(result.sourceEventId, "evt-1");
});

test("rejects an invalid source event identity", () => {
  assert.throws(
    () => new GenericProviderConversionNormalizer().normalize({ ...base, eventId: "   " }),
    /source event ID/
  );
});

test("rejects unknown conversion statuses", () => {
  assert.throws(
    () => new GenericProviderConversionNormalizer().normalize({
      ...base,
      payload: { ...base.payload, status: "settled" }
    }),
    /status is invalid/
  );
});

test("rejects commissions greater than the conversion amount", () => {
  assert.throws(
    () => new GenericProviderConversionNormalizer().normalize({
      ...base,
      payload: { ...base.payload, commissionCents: 10001 }
    }),
    /commission cannot exceed/
  );
});

test("rejects commissions on rejected conversions", () => {
  assert.throws(
    () => new GenericProviderConversionNormalizer().normalize({
      ...base,
      payload: { ...base.payload, status: "rejected", commissionCents: 1 }
    }),
    /cannot include a commission/
  );
});

test("rejects materially future conversion timestamps", () => {
  assert.throws(
    () => new GenericProviderConversionNormalizer().normalize({
      ...base,
      payload: { ...base.payload, occurredAt: "2099-01-01T00:00:00.000Z" }
    }),
    /materially in the future/
  );
});

test("rejects non-conversion event types even when normalization is called directly", () => {
  assert.throws(
    () => new GenericProviderConversionNormalizer().normalize({
      ...base,
      eventType: "order.created"
    }),
    /event type is unsupported/
  );
});


test("rejects an out-of-range commission during provider reconciliation", async () => {
  const { ConversionService } = await import("../../src/domain/services.js");
  const { InMemoryConversionRepository, InMemoryCommissionRepository, InMemoryRepository } = await import("../../src/domain/repository.js");

  const conversions = new InMemoryConversionRepository();
  const commissions = new InMemoryCommissionRepository();
  const affiliates = new InMemoryRepository<any>();
  const offers = new InMemoryRepository<any>();
  const affiliateOffers = new InMemoryRepository<any>();
  const conversion = {
    id: "conversion-1",
    affiliateId: "affiliate-1",
    offerId: "offer-1",
    amountCents: 10000,
    status: "pending",
    occurredAt: "2026-09-20T10:00:00.000Z"
  } as any;
  await conversions.save(conversion);
  await commissions.save({
    id: "commission-1",
    conversionId: conversion.id,
    affiliateId: conversion.affiliateId,
    amountCents: 1000,
    status: "pending",
    createdAt: "2026-09-20T10:00:00.000Z"
  } as any);

  const service = new ConversionService(
    conversions,
    commissions,
    affiliates,
    offers,
    affiliateOffers,
    { run: async (work: any) => work({ conversions, commissions }) }
  );

  await assert.rejects(
    () => service.reconcileProviderState(conversion.id, "approved", 10001),
    /commission.*conversion amount/
  );

  assert.equal((await commissions.findByConversionId(conversion.id))?.amountCents, 1000);
  assert.equal((await conversions.findById(conversion.id))?.status, "pending");
});
