import assert from "node:assert/strict";
import test from "node:test";
import type { Affiliate, Commission, Conversion, Offer } from "@affiliateos/shared";
import { DomainError } from "../src/domain/errors.js";
import { InMemoryRepository } from "../src/domain/repository.js";
import { ConversionService } from "../src/domain/services.js";

test("creating a conversion creates a pending commission using offer basis points", async () => {
  const affiliates = new InMemoryRepository<Affiliate>();
  const offers = new InMemoryRepository<Offer>();
  const conversions = new InMemoryRepository<Conversion>();
  const commissions = new InMemoryRepository<Commission>();
  const affiliate: Affiliate = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Partner",
    email: "partner@example.com",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  const offer: Offer = {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Standard",
    status: "active",
    commissionRateBps: 1250,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  affiliates.save(affiliate);
  offers.save(offer);

  const service = new ConversionService(conversions, commissions, affiliates, offers, { run: async (work) => work({ conversions, commissions }) });
  const conversion = await service.create({
    affiliateId: affiliate.id,
    offerId: offer.id,
    amountCents: 10_000,
    occurredAt: "2026-01-02T00:00:00.000Z"
  });

  assert.equal(conversion.status, "pending");
  assert.deepEqual(await commissions.list().then(items => items.map(({ amountCents, conversionId, status }) => ({ amountCents, conversionId, status }))), [
    { amountCents: 1250, conversionId: conversion.id, status: "pending" }
  ]);
});

test("creating a conversion rejects an inactive offer", async () => {
  const affiliates = new InMemoryRepository<Affiliate>();
  const offers = new InMemoryRepository<Offer>();
  const conversions = new InMemoryRepository<Conversion>();
  const commissions = new InMemoryRepository<Commission>();
  const affiliateId = "00000000-0000-4000-8000-000000000003";
  const offerId = "00000000-0000-4000-8000-000000000004";
  affiliates.save({ id: affiliateId, name: "Partner", email: "partner@example.com", status: "active", createdAt: new Date().toISOString() });
  offers.save({ id: offerId, name: "Paused", status: "archived", commissionRateBps: 1000, createdAt: new Date().toISOString() });
  const service = new ConversionService(conversions, commissions, affiliates, offers, { run: async (work) => work({ conversions, commissions }) });

  assert.rejects(
    () => service.create({ affiliateId, offerId, amountCents: 1000 }),
    (error: unknown) => error instanceof DomainError && error.code === "OFFER_NOT_ACTIVE"
  );
  assert.equal((await conversions.list()).length, 0);
  assert.equal((await commissions.list()).length, 0);
});