import assert from "node:assert/strict";
import test from "node:test";
import { ConversionService } from "../../src/domain/services.js";
import { InMemoryCommissionRepository, InMemoryConversionRepository, InMemoryRepository } from "../../src/domain/repository.js";

test("rejects an out-of-range commission during provider reconciliation", async () => {
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
    /commission cannot exceed the conversion amount/
  );

  assert.equal((await commissions.findByConversionId(conversion.id))?.amountCents, 1000);
  assert.equal((await conversions.findById(conversion.id))?.status, "pending");
});
