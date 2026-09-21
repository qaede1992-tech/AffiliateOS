import assert from "node:assert/strict";
import test from "node:test";
import { ProviderEventProcessor, type ProcessableProviderEvent, type ProviderEventInbox } from "../../src/domain/provider-event-processor.js";

function createInbox(): ProviderEventInbox & { event: ProcessableProviderEvent } {
  const event: ProcessableProviderEvent = {
    affiliateAccountId: "account-1",
    externalEventId: "evt-processor-1",
    eventType: "conversion.created",
    payload: { id: "evt-processor-1" },
    signatureVersion: "v1",
    status: "received",
    receivedAt: "2026-09-20T10:00:00.000Z"
  };
  return {
    event,
    async findByExternalId(accountId, eventId) {
      return accountId === event.affiliateAccountId && eventId === event.externalEventId ? this.event : undefined;
    },
    async claimForProcessing(accountId, eventId) {
      if (accountId !== this.event.affiliateAccountId || eventId !== this.event.externalEventId || !["received", "failed"].includes(this.event.status)) return false;
      this.event = { ...this.event, status: "processing" };
      return true;
    },
    async updateStatus(accountId, eventId, status, error) {
      if (accountId !== this.event.affiliateAccountId || eventId !== this.event.externalEventId) return false;
      this.event = { ...this.event, status, ...(error ? { error } : {}) } as ProcessableProviderEvent;
      return true;
    }
  };
}

test("processes an inbox event once and marks it processed", async () => {
  const inbox = createInbox();
  const processor = new ProviderEventProcessor(inbox);
  let calls = 0;

  const first = await processor.process("account-1", "evt-processor-1", async (event) => {
    calls += 1;
    assert.equal(event.status, "processing");
    return event.payload.id;
  });
  const second = await processor.process("account-1", "evt-processor-1", async () => {
    calls += 1;
    return "unexpected";
  });

  assert.deepEqual(first, { processed: true, result: "evt-processor-1" });
  assert.deepEqual(second, { processed: false });
  assert.equal(calls, 1);
  assert.equal(inbox.event.status, "processed");
});

test("records failed processing so a later retry can reclaim the event", async () => {
  const inbox = createInbox();
  const processor = new ProviderEventProcessor(inbox);

  await assert.rejects(
    processor.process("account-1", "evt-processor-1", async () => {
      throw new Error("normalization failed");
    }),
    /normalization failed/
  );
  assert.equal(inbox.event.status, "failed");

  const retry = await processor.process("account-1", "evt-processor-1", async () => "retried");
  assert.deepEqual(retry, { processed: true, result: "retried" });
  assert.equal(inbox.event.status, "processed");
});

test("does not process an event when another worker already claimed it", async () => {
  const inbox = createInbox();
  inbox.event = { ...inbox.event, status: "processing" };
  const processor = new ProviderEventProcessor(inbox);
  let calls = 0;

  const result = await processor.process("account-1", "evt-processor-1", async () => {
    calls += 1;
    return "unexpected";
  });

  assert.deepEqual(result, { processed: false });
  assert.equal(calls, 0);
});
