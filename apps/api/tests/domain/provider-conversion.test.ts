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
