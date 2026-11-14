import assert from "node:assert/strict";
import test from "node:test";
import { ProviderEventStore, type ProviderEventRecord } from "../src/db/provider-events.js";

const event: ProviderEventRecord = {
  id: "event-1",
  affiliateAccountId: "account-1",
  externalEventId: "external-1",
  eventType: "conversion.created",
  payload: { id: "external-1" },
  receivedAt: "2026-11-13T00:00:00.000Z"
};

test("provider event store wakes the scheduler only after a new event is inserted", async () => {
  let wakeCount = 0;
  const store = new ProviderEventStore({
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => ({ rowCount: 1 })
      })
    })
  });
  store.setWakeSignal(() => { wakeCount += 1; });

  assert.equal(await store.insertIfNew(event), true);
  assert.equal(wakeCount, 1);
});

test("provider event store does not wake for a duplicate event", async () => {
  let wakeCount = 0;
  const store = new ProviderEventStore({
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => ({ rowCount: 0 })
      })
    })
  });
  store.setWakeSignal(() => { wakeCount += 1; });

  assert.equal(await store.insertIfNew(event), false);
  assert.equal(wakeCount, 0);
});

test("provider event store returns the next due wake time", async () => {
  const expected = "2026-11-13T00:05:00.000Z";
  const store = new ProviderEventStore({
    select: () => ({
      from: () => ({
        where: async () => [{ nextAt: expected }]
      })
    })
  });

  assert.deepEqual(await store.nextWakeAt(), new Date(expected));
});

test("provider event store returns no wake time for an empty queue", async () => {
  const store = new ProviderEventStore({
    select: () => ({
      from: () => ({
        where: async () => [{ nextAt: null }]
      })
    })
  });

  assert.equal(await store.nextWakeAt(), undefined);
});
