import assert from "node:assert/strict";
import test from "node:test";
import { GenericProviderConversionNormalizer } from "../../src/domain/provider-conversion.js";

const normalizer = new GenericProviderConversionNormalizer();

test("normalizes a provider conversion into canonical cents and timestamps", () => {
  const result = normalizer.normalize({
    eventId: "evt_200",
    eventType: "conversion.created",
    payload: {
      id: "conv_200",
      affiliate_id: "aff_1",
      offer_id: "offer_1",
      tracking_link: "trk_1",
      order_id: "order_1",
      amount: "12.34",
      currency: "usd",
      commission: 1.23,
      created_at: "2026-09-20T10:00:00Z",
      status: "approved"
    }
  });
  assert.deepEqual(result, {
    externalConversionId: "conv_200",
    affiliateReference: "aff_1",
    offerReference: "offer_1",
    trackingReference: "trk_1",
    orderReference: "order_1",
    amountCents: 1234,
    currency: "USD",
    commissionCents: 123,
    occurredAt: "2026-09-20T10:00:00.000Z",
    status: "approved",
    sourceEventId: "evt_200",
    rawEventType: "conversion.created"
  });
});

test("rejects unknown conversion status instead of silently coercing it", () => {
  assert.throws(() => normalizer.normalize({ eventId: "evt_201", eventType: "conversion.created", payload: { id: "conv_201", amount_cents: 500, occurred_at: "2026-09-20T10:00:00Z", status: "new" } }), /status is invalid/);
});

test("rejects malformed monetary and timestamp fields", () => {
  assert.throws(() => normalizer.normalize({ eventId: "evt_202", eventType: "conversion.created", payload: { id: "conv_202", amount: -1, occurred_at: "2026-09-20T10:00:00Z" } }), /non-negative/);
  assert.throws(() => normalizer.normalize({ eventId: "evt_203", eventType: "conversion.created", payload: { id: "conv_203", amount_cents: 100 } }), /occurred-at/);
});
