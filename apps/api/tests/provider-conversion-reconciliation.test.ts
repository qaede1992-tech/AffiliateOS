import assert from "node:assert/strict";
import test from "node:test";
import { ConversionService } from "../src/domain/services.js";
import type { Commission, Conversion } from "@affiliateos/shared";

function setup(conversionStatus: Conversion["status"], commissionStatus: Commission["status"] = "pending") {
  const conversion: Conversion = {
    id: "conversion-1",
    affiliateId: "affiliate-1",
    offerId: "offer-1",
    amountCents: 1000,
    status: conversionStatus,
    occurredAt: "2026-10-13T00:00:00.000Z",
    idempotencyKey: "provider:account-1:conversion-1"
  };
  const commission: Commission = {
    id: "commission-1",
    conversionId: conversion.id,
    affiliateId: conversion.affiliateId,
    amountCents: 100,
    status: commissionStatus,
    createdAt: "2026-10-13T00:00:00.000Z"
  };
  const conversionSaves: Conversion[] = [];
  const commissionSaves: Commission[] = [];
  const conversions = {
    findById: async (id: string) => id === conversion.id ? conversion : undefined,
    save: async (entity: Conversion) => { conversionSaves.push(entity); return entity; }
  };
  const commissions = {
    findByConversionId: async (id: string) => id === conversion.id ? commission : undefined,
    save: async (entity: Commission) => { commissionSaves.push(entity); return entity; }
  };
  const transactionManager = {
    run: async <T>(work: (repos: any) => Promise<T>) => work({ conversions, commissions })
  };
  const service = new ConversionService(
    conversions as never, commissions as never, {} as never, {} as never, {} as never, transactionManager as never
  );
  return { service, conversion, commission, conversionSaves, commissionSaves };
}

test("ignores a replayed pending provider state after approval", async () => {
  const state = setup("approved", "approved");
  const result = await state.service.reconcileProviderState("conversion-1", "pending", 90);
  assert.equal(result.status, "approved");
  assert.equal(state.conversionSaves.length, 0);
  assert.equal(state.commissionSaves.length, 0);
});

test("does not downgrade an already rejected conversion on a pending replay", async () => {
  const state = setup("rejected");
  const result = await state.service.reconcileProviderState("conversion-1", "pending", 90);
  assert.equal(result.status, "rejected");
  assert.equal(state.conversionSaves.length, 0);
  assert.equal(state.commissionSaves.length, 0);
});

test("does not alter the amount or status of a paid commission during reconciliation", async () => {
  const state = setup("pending", "paid");
  const result = await state.service.reconcileProviderState("conversion-1", "approved", 90);
  assert.equal(result.status, "approved");
  assert.equal(state.conversionSaves.length, 1);
  assert.equal(state.commissionSaves.length, 0);
  assert.equal(state.commission.amountCents, 100);
  assert.equal(state.commission.status, "paid");
});

test("does not replace the commission amount from a rejected report", async () => {
  const state = setup("pending", "approved");
  const result = await state.service.reconcileProviderState("conversion-1", "rejected", 90);
  assert.equal(result.status, "rejected");
  assert.equal(state.commissionSaves.length, 1);
  assert.equal(state.commissionSaves[0]?.amountCents, 100);
  assert.equal(state.commissionSaves[0]?.status, "pending");
});
