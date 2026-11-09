import assert from "node:assert/strict";
import test from "node:test";
import { ShopeeIntakeRecoveryScheduler } from "../../src/domain/shopee-intake-recovery-scheduler.js";

test("Shopee intake recovery scheduler backs off only after consecutive empty polls", async () => {
  const results = [
    { scanned: 0, recovered: 0, failed: 0, skipped: 0 },
    { scanned: 0, recovered: 0, failed: 0, skipped: 0 },
    { scanned: 0, recovered: 0, failed: 0, skipped: 0 },
    { scanned: 1, recovered: 1, failed: 0, skipped: 0 }
  ];
  const scheduler = new ShopeeIntakeRecoveryScheduler(
    { runOnce: async () => results.shift()! },
    { intervalMs: 10_000, idleMaxIntervalMs: 40_000 }
  );

  assert.equal(scheduler.nextIntervalMs, 10_000);
  await scheduler.runNow();
  assert.equal(scheduler.nextIntervalMs, 10_000, "first empty poll retains the normal interval");
  await scheduler.runNow();
  assert.equal(scheduler.nextIntervalMs, 20_000);
  await scheduler.runNow();
  assert.equal(scheduler.nextIntervalMs, 40_000, "idle interval is capped");
  await scheduler.runNow();
  assert.equal(scheduler.nextIntervalMs, 10_000, "new recovery work resets the interval");
});

test("Shopee intake recovery scheduler retries worker failures at the base interval", async () => {
  let shouldFail = true;
  const scheduler = new ShopeeIntakeRecoveryScheduler(
    { runOnce: async () => {
      if (shouldFail) throw new Error("temporary database failure");
      return { scanned: 0, recovered: 0, failed: 0, skipped: 0 };
    } },
    { intervalMs: 10_000, idleMaxIntervalMs: 40_000 }
  );

  await assert.rejects(scheduler.runNow(), /temporary database failure/);
  assert.equal(scheduler.nextIntervalMs, 10_000);
  shouldFail = false;
  await scheduler.runNow();
  await scheduler.runNow();
  assert.equal(scheduler.nextIntervalMs, 20_000);
});

test("Shopee intake recovery scheduler waits for active work and does not abort shutdown on worker failure", async () => {
  let rejectRun!: (error: Error) => void;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const errors: unknown[] = [];
  const scheduler = new ShopeeIntakeRecoveryScheduler(
    {
      runOnce: () => {
        resolveStarted();
        return new Promise((_, reject) => { rejectRun = reject; });
      }
    },
    { intervalMs: 10_000, onError: (error) => errors.push(error) }
  );

  scheduler.start();
  await started;

  let stopSettled = false;
  const stopping = scheduler.stop().finally(() => { stopSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);

  rejectRun(new Error("temporary database failure"));
  await stopping;

  assert.equal(stopSettled, true);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "temporary database failure");
});
