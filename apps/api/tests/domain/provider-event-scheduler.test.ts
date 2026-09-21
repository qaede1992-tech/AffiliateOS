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
