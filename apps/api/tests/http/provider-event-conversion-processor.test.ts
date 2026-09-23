import assert from "node:assert/strict";
import test from "node:test";
import { ProviderEventConversionProcessor, StaticProviderEventConversionNormalizerRegistry } from "../../src/domain/provider-event-conversion-processor.js";
import { GenericProviderConversionNormalizer } from "../../src/domain/provider-conversion.js";
import { ProviderConversionProcessor } from "../../src/domain/provider-conversion-processor.js";
import { ProviderEventProcessor } from "../../src/domain/provider-event-processor.js";

function inbox() {
  const events = new Map<string, { affiliateAccountId: string; externalEventId: string; eventType: string; payload: Record<string, unknown>; status: string; receivedAt: string }>();
  return {
    events,
    async findByExternalId(account: string, id: string) { const event = events.get(`${account}:${id}`); return event; },
    async claimForProcessing(account: string, id: string) { const event = events.get(`${account}:${id}`); if (!event || (event.status !== "received" && event.status !== "failed")) return false; event.status = "processing"; return true; },
    async updateStatus(account: string, id: string, status: "received" | "processing" | "processed" | "failed") { const event = events.get(`${account}:${id}`); if (!event) return false; event.status = status; return true; },
    add(account: string, id: string, payload: Record<string, unknown>) { events.set(`${account}:${id}`, { affiliateAccountId: account, externalEventId: id, eventType: "conversion.created", payload, status: "received", receivedAt: "2026-09-20T00:00:00.000Z" }); }
  };
}

test("orchestrates inbox claim, normalization, and conversion processing", async () => {
  const store = inbox();
  store.add("account-a", "evt-1", { conversion_id: "conv-1", affiliate_reference: "aff-1", offer_reference: "offer-1", amount_cents: 1250, occurred_at: "2026-09-20T00:00:00.000Z", status: "approved", tracking_reference: "track-1" });

  const created: unknown[] = [];
  const reconciled: unknown[] = [];
  const attributed: unknown[] = [];
  const conversionProcessor = new ProviderConversionProcessor({
    async create(input) { created.push(input); return { id: "conversion-1", affiliateId: input.affiliateId, offerId: input.offerId, amountCents: input.amountCents, status: "pending", occurredAt: input.occurredAt, idempotencyKey: input.idempotencyKey }; }
    async reconcileProviderState(conversionId: string, status: "pending" | "approved" | "rejected", commissionCents?: number) { reconciled.push({ conversionId, status, commissionCents }); return { id: conversionId, affiliateId: "affiliate-1", offerId: "offer-1", amountCents: 1250, status, occurredAt: "2026-09-20T00:00:00.000Z" }; }
  } as any, {
    async resolveAffiliate(reference) { return reference === "aff-1" ? "affiliate-1" : undefined; },
    async resolveOffer(reference) { return reference === "offer-1" ? "offer-1" : undefined; }
  });

  const processor = new ProviderEventConversionProcessor(
    new ProviderEventProcessor(store),
    new StaticProviderEventConversionNormalizerRegistry([new GenericProviderConversionNormalizer()]),
    conversionProcessor
  );

  const result = await processor.process("account-a", "evt-1");
  assert.equal(result.processed, true);
  assert.equal(result.conversion?.id, "conversion-1");
  assert.equal(created.length, 1);
  assert.deepEqual(reconciled, [{ conversionId: "conversion-1", status: "approved", commissionCents: undefined }]);
  assert.deepEqual(attributed, [{ conversionId: "conversion-1", trackingLinkId: "tracking-link-1" }]);
  assert.equal((created[0] as { idempotencyKey: string }).idempotencyKey, "provider:account-a:conv-1");
  assert.equal(store.events.get("account-a:evt-1")?.status, "processed");
});

test("marks unsupported provider conversion events failed and allows retry after correction", async () => {
  const store = inbox();
  store.add("account-a", "evt-2", { id: "evt-2" });
  const processor = new ProviderEventConversionProcessor(
    new ProviderEventProcessor(store),
    new StaticProviderEventConversionNormalizerRegistry([new GenericProviderConversionNormalizer()]),
    {} as any
  );

  await assert.rejects(() => processor.process("account-a", "evt-2"), /not supported/);
  assert.equal(store.events.get("account-a:evt-2")?.status, "failed");
});
