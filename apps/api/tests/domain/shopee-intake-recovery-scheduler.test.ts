import assert from "node:assert/strict";
import test from "node:test";
import { ShopeeIntakeRecoveryScheduler } from "../../src/domain/shopee-intake-recovery-scheduler.js";

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
