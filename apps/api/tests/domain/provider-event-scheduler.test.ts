import assert from "node:assert/strict";
import test from "node:test";
import { ProviderEventScheduler } from "../../src/domain/provider-event-scheduler.js";

test("provider event scheduler prevents overlapping runs", async () => {
  let calls = 0;
  let release!: () => void;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const worker = {
    runOnce: async () => {
      calls += 1;
      resolveStarted();
      await new Promise<void>((resolve) => { release = resolve; });
      return { scanned: 1, processed: 1, failed: 0 };
    }
  };
  const scheduler = new ProviderEventScheduler(worker, { intervalMs: 10_000 });

  const first = scheduler.runNow();
  await started;
  const second = scheduler.runNow();

  let secondSettled = false;
  void second.finally(() => { secondSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  assert.equal(calls, 1);

  release();
  assert.deepEqual(await first, { scanned: 1, processed: 1, failed: 0 });
  assert.deepEqual(await second, { scanned: 1, processed: 1, failed: 0 });
  assert.equal(calls, 1);
});

test("provider event scheduler stops future cycles and waits for active work", async () => {
  let calls = 0;
  let release!: () => void;
  const worker = {
    runOnce: async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return { scanned: 0, processed: 0, failed: 0 };
    }
  };
  const scheduler = new ProviderEventScheduler(worker, { intervalMs: 10_000 });
  scheduler.start();

  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  const stopping = scheduler.stop();
  release();
  await stopping;

  assert.equal(calls, 1);
  assert.equal(scheduler.isRunning, false);
});


test("provider event scheduler preserves worker success when result observer fails", async () => {
  const errors: unknown[] = [];
  const scheduler = new ProviderEventScheduler(
    { runOnce: async () => ({ scanned: 1, processed: 1, failed: 0 }) },
    {
      onResult: () => { throw new Error("result observer failure"); },
      onError: (error) => errors.push(error)
    }
  );

  assert.deepEqual(await scheduler.runNow(), { scanned: 1, processed: 1, failed: 0 });
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "result observer failure");
});

test("provider event scheduler does not reject because error observer fails", async () => {
  const scheduler = new ProviderEventScheduler(
    { runOnce: async () => { throw new Error("worker failure"); } },
    { onError: () => { throw new Error("error observer failure"); } }
  );

  await assert.rejects(scheduler.runNow(), /worker failure/);
});


test("provider event scheduler backs off consecutive empty polls and resets when work appears", async () => {
  const results = [
    { scanned: 0, processed: 0, failed: 0 },
    { scanned: 0, processed: 0, failed: 0 },
    { scanned: 0, processed: 0, failed: 0 },
    { scanned: 2, processed: 2, failed: 0 },
    { scanned: 0, processed: 0, failed: 0 }
  ];
  const scheduler = new ProviderEventScheduler(
    { runOnce: async () => results.shift()! },
    { intervalMs: 10_000, idleMaxIntervalMs: 40_000 }
  );

  await scheduler.runNow();
  assert.equal(scheduler.nextIntervalMs, 10_000);
  await scheduler.runNow();
  assert.equal(scheduler.nextIntervalMs, 20_000);
  await scheduler.runNow();
  assert.equal(scheduler.nextIntervalMs, 40_000);
  await scheduler.runNow();
  assert.equal(scheduler.nextIntervalMs, 10_000);
  await scheduler.runNow();
  assert.equal(scheduler.nextIntervalMs, 10_000);
});

test("provider event scheduler resets idle backoff after worker failure", async () => {
  let calls = 0;
  const scheduler = new ProviderEventScheduler(
    { runOnce: async () => {
      calls += 1;
      if (calls === 3) throw new Error("temporary database failure");
      return { scanned: 0, processed: 0, failed: 0 };
    } },
    { intervalMs: 10_000, idleMaxIntervalMs: 40_000 }
  );

  await scheduler.runNow();
  await scheduler.runNow();
  assert.equal(scheduler.nextIntervalMs, 20_000);
  await assert.rejects(scheduler.runNow(), /temporary database failure/);
  assert.equal(scheduler.nextIntervalMs, 10_000);
});


test("provider event scheduler stores only a safe error type in status", async () => {
  const marker = "private-provider-event-db-marker";
  const databaseError = new Error(`Failed query: SELECT * FROM provider_events; params: ${marker}`);
  databaseError.name = "DatabaseError";
  const scheduler = new ProviderEventScheduler(
    { runOnce: async () => { throw databaseError; } }
  );

  await assert.rejects(scheduler.runNow());
  assert.equal(scheduler.status.lastError, "DatabaseError");
  assert.doesNotMatch(scheduler.status.lastError ?? "", /Failed query|params:|private-provider-event-db-marker/i);
});
