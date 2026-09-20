import assert from "node:assert/strict";
import test from "node:test";
import { ProviderEventProcessor, type ProcessableProviderEvent, type ProviderEventInbox } from "../../src/domain/provider-event-processor.js";

class InMemoryInbox implements ProviderEventInbox {
  private readonly events = new Map<string, ProcessableProviderEvent>();

  constructor(event: ProcessableProviderEvent) {
    this.events.set(this.key(event.affiliateAccountId, event.externalEventId), event);
  }

  async findByExternalId(affiliateAccountId: string, externalEventId: string) {
    return this.events.get(this.key(affiliateAccountId, externalEventId));
  }

  async claimForProcessing(affiliateAccountId: string, externalEventId: string) {
    const key = this.key(affiliateAccountId, externalEventId);
    const event = this.events.get(key);
    if (!event || (event.status !== "received" && event.status !== "failed")) return false;
    this.events.set(key, { ...event, status: "processing" });
    return true;
  }

  async updateStatus(affiliateAccountId: string, externalEventId: string, status: "received" | "processing" | "processed" | "failed", error?: string) {
    const key = this.key(affiliateAccountId, externalEventId);
    const event = this.events.get(key);
    if (!event) return false;
    this.events.set(key, { ...event, status, ...(error ? { error } : {}) } as ProcessableProviderEvent);
    return true;
  }

  get(affiliateAccountId: string, externalEventId: string) {
    return this.events.get(this.key(affiliateAccountId, externalEventId));
  }

  private key(affiliateAccountId: string, externalEventId: string) {
    return `${affiliateAccountId}:${externalEventId}`;
  }
}

function event(status: string = "received"): ProcessableProviderEvent {
  return {
    affiliateAccountId: "account-a",
    externalEventId: "evt-1",
    eventType: "conversion.created",
    payload: { id: "evt-1" },
    signatureVersion: "v1",
    status,
    receivedAt: "2026-09-20T00:00:00.000Z"
  };
}

test("claims an inbox event and marks it processed only after the handler succeeds", async () => {
  const inbox = new InMemoryInbox(event());
  const processor = new ProviderEventProcessor(inbox);
  const seen: string[] = [];

  const result = await processor.process("account-a", "evt-1", async (received) => {
    seen.push(received.status);
    return "conversion-1";
  });

  assert.deepEqual(seen, ["processing"]);
  assert.deepEqual(result, { processed: true, result: "conversion-1" });
  assert.equal(inbox.get("account-a", "evt-1")?.status, "processed");
});

test("does not run the handler twice for a processed event", async () => {
  const inbox = new InMemoryInbox(event("processed"));
  const processor = new ProviderEventProcessor(inbox);
  let calls = 0;

  const result = await processor.process("account-a", "evt-1", async () => {
    calls += 1;
    return true;
  });

  assert.deepEqual(result, { processed: false });
  assert.equal(calls, 0);
});

test("marks failed processing for retry and allows the next attempt to claim it", async () => {
  const inbox = new InMemoryInbox(event());
  const processor = new ProviderEventProcessor(inbox);
  let calls = 0;

  await assert.rejects(
    processor.process("account-a", "evt-1", async () => {
      calls += 1;
      throw new Error("temporary downstream failure");
    }),
    /temporary downstream failure/
  );
  assert.equal(inbox.get("account-a", "evt-1")?.status, "failed");

  const retry = await processor.process("account-a", "evt-1", async () => {
    calls += 1;
    return "ok";
  });

  assert.deepEqual(retry, { processed: true, result: "ok" });
  assert.equal(calls, 2);
  assert.equal(inbox.get("account-a", "evt-1")?.status, "processed");
});

test("does not process an event concurrently after another worker claims it", async () => {
  const inbox = new InMemoryInbox(event());
  const processor = new ProviderEventProcessor(inbox);
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;

  const first = processor.process("account-a", "evt-1", async () => {
    calls += 1;
    await blocker;
    return "first";
  });
  await new Promise((resolve) => setImmediate(resolve));

  const second = await processor.process("account-a", "evt-1", async () => {
    calls += 1;
    return "second";
  });

  assert.deepEqual(second, { processed: false });
  release();
  assert.deepEqual(await first, { processed: true, result: "first" });
  assert.equal(calls, 1);
});

test("rejects processing when the event does not exist", async () => {
  const inbox = new InMemoryInbox(event());
  const processor = new ProviderEventProcessor(inbox);

  await assert.rejects(
    processor.process("account-a", "missing", async () => true),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "PROVIDER_EVENT_NOT_FOUND"
  );
});
