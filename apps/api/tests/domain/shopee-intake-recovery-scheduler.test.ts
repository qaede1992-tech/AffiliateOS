import assert from "node:assert/strict";
import test from "node:test";
import { ShopeeIntakeRecoveryScheduler } from "../../src/domain/shopee-intake-recovery-scheduler.js";
import type { ShopeeIntakeRecoveryResult } from "../../src/domain/shopee-affiliate-link-intake.js";

type FakeTimer = { callback: () => void; delayMs: number; unref: () => void };
const empty: ShopeeIntakeRecoveryResult = { scanned: 0, recovered: 0, failed: 0, skipped: 0 };

function fakeTimers() {
  const scheduled: FakeTimer[] = [];
  const cleared: FakeTimer[] = [];
  return {
    scheduled,
    cleared,
    setTimer: (callback: () => void, delayMs: number) => {
      const timer: FakeTimer = { callback, delayMs, unref: () => undefined };
      scheduled.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      cleared.push(handle as unknown as FakeTimer);
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Shopee recovery startup performs only a bounded wake lookup when no intake is resolving", async () => {
  const timers = fakeTimers();
  let lookups = 0;
  let runs = 0;
  const scheduler = new ShopeeIntakeRecoveryScheduler(
    {
      runOnce: async () => { runs += 1; return empty; },
      nextWakeAt: async () => { lookups += 1; return undefined; }
    },
    { setTimer: timers.setTimer, clearTimer: timers.clearTimer }
  );

  scheduler.start();
  await flush();

  assert.equal(lookups, 1);
  assert.equal(runs, 0);
  assert.equal(timers.scheduled.length, 0);
  await scheduler.stop();
});

test("Shopee recovery schedules the exact stale deadline without running early", async () => {
  const timers = fakeTimers();
  let runs = 0;
  const scheduler = new ShopeeIntakeRecoveryScheduler(
    {
      runOnce: async () => { runs += 1; return empty; },
      nextWakeAt: async () => new Date("2026-11-13T10:05:00.000Z")
    },
    {
      now: () => new Date("2026-11-13T10:00:00.000Z"),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer
    }
  );

  scheduler.start();
  await flush();
  assert.equal(runs, 0);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0]?.delayMs, 300_000);
  await scheduler.stop();
});

test("Shopee recovery refreshes its wake when intake state changes", async () => {
  const timers = fakeTimers();
  let nextAt = new Date("2026-11-13T10:05:00.000Z");
  let runs = 0;
  const scheduler = new ShopeeIntakeRecoveryScheduler(
    { runOnce: async () => { runs += 1; return empty; }, nextWakeAt: async () => nextAt },
    { now: () => new Date("2026-11-13T10:00:00.000Z"), setTimer: timers.setTimer, clearTimer: timers.clearTimer }
  );

  scheduler.start();
  await flush();
  nextAt = new Date("2026-11-13T10:02:00.000Z");
  scheduler.notifyChanged();
  await flush();

  assert.equal(runs, 0);
  assert.equal(timers.cleared.length, 1);
  assert.equal(timers.scheduled.length, 2);
  assert.equal(timers.scheduled[1]?.delayMs, 120_000);
  await scheduler.stop();
});

test("Shopee recovery runs once when the stale deadline arrives and becomes idle again", async () => {
  const timers = fakeTimers();
  let runs = 0;
  let lookups = 0;
  const scheduler = new ShopeeIntakeRecoveryScheduler(
    {
      runOnce: async () => { runs += 1; return { scanned: 1, recovered: 1, failed: 0, skipped: 0 }; },
      nextWakeAt: async () => {
        lookups += 1;
        return lookups === 1 ? new Date("2026-11-13T10:00:00.000Z") : undefined;
      }
    },
    { now: () => new Date("2026-11-13T10:00:00.000Z"), setTimer: timers.setTimer, clearTimer: timers.clearTimer }
  );

  scheduler.start();
  await flush();
  assert.equal(runs, 0);
  assert.equal(timers.scheduled[0]?.delayMs, 0);
  timers.scheduled[0]!.callback();
  await flush();

  assert.equal(runs, 1);
  assert.equal(lookups, 2);
  assert.equal(timers.scheduled.length, 1);
  await scheduler.stop();
});

test("Shopee recovery invalidates a wake lookup when intake changes during inspection", async () => {
  const firstLookup = deferred<Date | undefined>();
  const timers = fakeTimers();
  let lookups = 0;
  let runs = 0;
  const scheduler = new ShopeeIntakeRecoveryScheduler(
    {
      runOnce: async () => { runs += 1; return empty; },
      nextWakeAt: async () => {
        lookups += 1;
        return lookups === 1 ? firstLookup.promise : undefined;
      }
    },
    { setTimer: timers.setTimer, clearTimer: timers.clearTimer }
  );

  scheduler.start();
  assert.equal(lookups, 1);
  scheduler.notifyChanged();
  firstLookup.resolve(new Date("2026-11-13T10:05:00.000Z"));
  await flush();

  assert.equal(lookups, 2);
  assert.equal(runs, 0);
  assert.equal(timers.scheduled.length, 0);
  await scheduler.stop();
});

test("Shopee recovery does not schedule after stop during a wake lookup", async () => {
  const firstLookup = deferred<Date | undefined>();
  const timers = fakeTimers();
  let runs = 0;
  const scheduler = new ShopeeIntakeRecoveryScheduler(
    { runOnce: async () => { runs += 1; return empty; }, nextWakeAt: async () => firstLookup.promise },
    { setTimer: timers.setTimer, clearTimer: timers.clearTimer }
  );

  scheduler.start();
  await scheduler.stop();
  firstLookup.resolve(new Date("2026-11-13T10:05:00.000Z"));
  await flush();

  assert.equal(runs, 0);
  assert.equal(timers.scheduled.length, 0);
});

test("Shopee recovery retries wake lookup failures at the configured retry interval", async () => {
  const timers = fakeTimers();
  const errors: unknown[] = [];
  const scheduler = new ShopeeIntakeRecoveryScheduler(
    { runOnce: async () => empty, nextWakeAt: async () => { throw new Error("database unavailable"); } },
    { intervalMs: 12_000, setTimer: timers.setTimer, clearTimer: timers.clearTimer, onError: (error) => errors.push(error) }
  );

  scheduler.start();
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(timers.scheduled[0]?.delayMs, 12_000);
  await scheduler.stop();
});

test("Shopee recovery backs off after a worker error without overlapping runs", async () => {
  const timers = fakeTimers();
  const errors: unknown[] = [];
  let runs = 0;
  const scheduler = new ShopeeIntakeRecoveryScheduler(
    {
      runOnce: async () => { runs += 1; throw new Error("temporary database failure"); },
      nextWakeAt: async () => new Date("2026-11-13T10:00:00.000Z")
    },
    {
      now: () => new Date("2026-11-13T10:00:00.000Z"),
      intervalMs: 10_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onError: (error) => errors.push(error)
    }
  );

  scheduler.start();
  await flush();
  timers.scheduled[0]!.callback();
  await flush();

  assert.equal(runs, 1);
  assert.equal(errors.length, 1);
  assert.equal(timers.scheduled[1]?.delayMs, 10_000);
  await scheduler.stop();
});

test("Shopee recovery runNow calls are coalesced while one worker is active", async () => {
  const first = deferred<ShopeeIntakeRecoveryResult>();
  let runs = 0;
  const scheduler = new ShopeeIntakeRecoveryScheduler({
    runOnce: async () => { runs += 1; return first.promise; },
    nextWakeAt: async () => undefined
  });

  const one = scheduler.runNow();
  const two = scheduler.runNow();
  await Promise.resolve();
  assert.equal(runs, 1);
  first.resolve(empty);
  await Promise.all([one, two]);
});

test("Shopee recovery waits for active work and does not abort shutdown on worker failure", async () => {
  const first = deferred<ShopeeIntakeRecoveryResult>();
  const errors: unknown[] = [];
  const scheduler = new ShopeeIntakeRecoveryScheduler(
    { runOnce: () => first.promise, nextWakeAt: async () => undefined },
    { onError: (error) => errors.push(error) }
  );

  scheduler.start();
  const running = scheduler.runNow();
  await Promise.resolve();
  let stopSettled = false;
  const stopping = scheduler.stop().finally(() => { stopSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);

  first.reject(new Error("temporary database failure"));
  await assert.rejects(running, /temporary database failure/);
  await stopping;

  assert.equal(stopSettled, true);
  assert.equal(errors.length, 1);
});
