import assert from "node:assert/strict";
import test from "node:test";
import type { Affiliate, Commission, Offer } from "@affiliateos/shared";
import { DomainError } from "../src/domain/errors.js";
import { InMemoryCommissionRepository, InMemoryConversionRepository, InMemoryRepository } from "../src/domain/repository.js";
import { ConversionService } from "../src/domain/services.js";

test("creating a conversion creates a pending commission using offer basis points", async () => {
  const affiliates = new InMemoryRepository<Affiliate>();
  const offers = new InMemoryRepository<Offer>();
  const conversions = new InMemoryConversionRepository();
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

test("creating a conversion with the same idempotency key returns the original conversion", async () => {
  const affiliates = new InMemoryRepository<Affiliate>();
  const offers = new InMemoryRepository<Offer>();
  const conversions = new InMemoryConversionRepository();
  const commissions = new InMemoryRepository<Commission>();
  const affiliate: Affiliate = { id: "00000000-0000-4000-8000-000000000005", name: "Partner", email: "partner@example.com", status: "active", createdAt: new Date().toISOString() };
  const offer: Offer = { id: "00000000-0000-4000-8000-000000000006", name: "Standard", status: "active", commissionRateBps: 1000, createdAt: new Date().toISOString() };
  await affiliates.save(affiliate);
  await offers.save(offer);
  const service = new ConversionService(conversions, commissions, affiliates, offers, { run: async (work) => work({ conversions, commissions }) });
  const input = { affiliateId: affiliate.id, offerId: offer.id, amountCents: 5000, idempotencyKey: "conversion-event-001" };

  const first = await service.create(input);
  const second = await service.create(input);

  assert.equal(second.id, first.id);
  assert.equal((await conversions.list()).length, 1);
  assert.equal((await commissions.list()).length, 1);
});

test("reusing a conversion idempotency key for different data is rejected", async () => {
  const affiliates = new InMemoryRepository<Affiliate>();
  const offers = new InMemoryRepository<Offer>();
  const conversions = new InMemoryConversionRepository();
  const commissions = new InMemoryRepository<Commission>();
  const affiliateId = "00000000-0000-4000-8000-000000000007";
  const offerId = "00000000-0000-4000-8000-000000000008";
  await affiliates.save({ id: affiliateId, name: "Partner", email: "partner@example.com", status: "active", createdAt: new Date().toISOString() });
  await offers.save({ id: offerId, name: "Standard", status: "active", commissionRateBps: 1000, createdAt: new Date().toISOString() });
  const service = new ConversionService(conversions, commissions, affiliates, offers, { run: async (work) => work({ conversions, commissions }) });
  await service.create({ affiliateId, offerId, amountCents: 1000, idempotencyKey: "conversion-event-002" });

  await assert.rejects(
    () => service.create({ affiliateId, offerId, amountCents: 2000, idempotencyKey: "conversion-event-002" }),
    (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_KEY_CONFLICT" && error.statusCode === 409
  );
});

test("creating a conversion rejects an inactive offer", async () => {
  const affiliates = new InMemoryRepository<Affiliate>();
  const offers = new InMemoryRepository<Offer>();
  const conversions = new InMemoryConversionRepository();
  const commissions = new InMemoryRepository<Commission>();
  const affiliateId = "00000000-0000-4000-8000-000000000003";
  const offerId = "00000000-0000-4000-8000-000000000004";
  affiliates.save({ id: affiliateId, name: "Partner", email: "partner@example.com", status: "active", createdAt: new Date().toISOString() });
  offers.save({ id: offerId, name: "Paused", status: "archived", commissionRateBps: 1000, createdAt: new Date().toISOString() });
  const service = new ConversionService(conversions, commissions, affiliates, offers, { run: async (work) => work({ conversions, commissions }) });

  await assert.rejects(
    () => service.create({ affiliateId, offerId, amountCents: 1000 }),
    (error: unknown) => error instanceof DomainError && error.code === "OFFER_NOT_ACTIVE"
  );
  assert.equal((await conversions.list()).length, 0);
  assert.equal((await commissions.list()).length, 0);
});

test("reconciling a provider rejection preserves rejected state on conversion and commission", async () => {
  const affiliates = new InMemoryRepository<Affiliate>();
  const offers = new InMemoryRepository<Offer>();
  const conversions = new InMemoryConversionRepository();
  const commissions = new InMemoryCommissionRepository();
  const affiliate: Affiliate = {
    id: "00000000-0000-4000-8000-000000000009",
    name: "Partner",
    email: "partner@example.com",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  const offer: Offer = {
    id: "00000000-0000-4000-8000-000000000010",
    name: "Standard",
    status: "active",
    commissionRateBps: 1000,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  await affiliates.save(affiliate);
  await offers.save(offer);

  const service = new ConversionService(
    conversions,
    commissions,
    affiliates,
    offers,
    { run: async (work) => work({ conversions, commissions }) }
  );
  const conversion = await service.create({
    affiliateId: affiliate.id,
    offerId: offer.id,
    amountCents: 10_000
  });

  const reconciled = await service.reconcileProviderState(conversion.id, "rejected");

  assert.equal(reconciled.status, "rejected");
  assert.equal((await conversions.findById(conversion.id))?.status, "rejected");
  assert.equal((await commissions.findByConversionId(conversion.id))?.status, "rejected");
});
