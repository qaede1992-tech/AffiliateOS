import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PublicationWorker, PublicationWorkerResult } from "../../src/domain/publication-worker.js";
import { PublicationScheduler } from "../../src/domain/publication-scheduler.js";

type Timer = ReturnType<typeof setTimeout>;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const fakeTimers = () => {
  const scheduled: Array<{ handle: Timer; callback: () => void; delayMs: number }> = [];
  const cleared: Timer[] = [];
  let nextId = 0;
  const setTimer = ((callback: () => void, delayMs: number) => {
    const handle = { id: ++nextId, unref: () => undefined } as unknown as Timer;
    scheduled.push({ handle, callback, delayMs });
    return handle;
  }) as (callback: () => void, delayMs: number) => Timer;
  const clearTimer = (handle: Timer) => { cleared.push(handle); };
  return { scheduled, cleared, setTimer, clearTimer };
};

const emptyResult: PublicationWorkerResult[] = [];
const worker = (runOnce: () => Promise<PublicationWorkerResult[]>, nextWakeAt: () => Promise<Date | undefined>) =>
  ({ runOnce, nextWakeAt }) as unknown as PublicationWorker;

describe("PublicationScheduler", () => {
  it("does not run the worker or schedule a timer when the queue is empty", async () => {
    let calls = 0;
    const timers = fakeTimers();
    const scheduler = new PublicationScheduler(
      worker(async () => { calls += 1; return emptyResult; }, async () => undefined),
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer }
    );

    scheduler.start();
    await flush();
    assert.equal(calls, 0);
    assert.equal(timers.scheduled.length, 0);
    await scheduler.stop();
  });

  it("schedules the next worker run at the exact due time", async () => {
    const timers = fakeTimers();
    const now = new Date("2026-09-21T10:00:00.000Z");
    const scheduler = new PublicationScheduler(
      worker(async () => emptyResult, async () => new Date("2026-09-21T10:02:00.000Z")),
      { now: () => now, setTimer: timers.setTimer, clearTimer: timers.clearTimer }
    );

    scheduler.start();
    await flush();
    assert.equal(timers.scheduled.length, 1);
    assert.equal(timers.scheduled[0]?.delayMs, 120_000);
    await scheduler.stop();
    assert.equal(timers.cleared.length, 1);
  });

  it("cancels a future wake when a new job is scheduled", async () => {
    const timers = fakeTimers();
    let calls = 0;
    let nextAt: Date | undefined = new Date("2026-09-21T10:02:00.000Z");
    const scheduler = new PublicationScheduler(
      worker(async () => { calls += 1; return emptyResult; }, async () => nextAt),
      { now: () => new Date("2026-09-21T10:00:00.000Z"), setTimer: timers.setTimer, clearTimer: timers.clearTimer }
    );

    scheduler.start();
    await flush();
    assert.equal(timers.scheduled.length, 1);
    nextAt = undefined;
    await scheduler.trigger();
    assert.equal(calls, 2);
    assert.equal(timers.cleared.length, 1);
    assert.equal(timers.scheduled.length, 1);
    await scheduler.stop();
  });

  it("coalesces multiple triggers received during an active worker run", async () => {
    const first = deferred<PublicationWorkerResult[]>();
    let calls = 0;
    const timers = fakeTimers();
    const scheduler = new PublicationScheduler(
      worker(async () => { calls += 1; return calls === 1 ? first.promise : emptyResult; }, async () => undefined),
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer }
    );

    scheduler.start();
    await Promise.resolve();
    const one = scheduler.trigger();
    const two = scheduler.trigger();
    const three = scheduler.trigger();
    assert.equal(calls, 1);
    first.resolve(emptyResult);
    await Promise.all([one, two, three]);
    assert.equal(calls, 2);
    assert.equal(timers.scheduled.length, 0);
    await scheduler.stop();
  });

  it("preserves a trigger received during a manual worker run", async () => {
    const first = deferred<PublicationWorkerResult[]>();
    let calls = 0;
    const timers = fakeTimers();
    const scheduler = new PublicationScheduler(
      worker(async () => { calls += 1; return calls === 1 ? first.promise : emptyResult; }, async () => undefined),
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer }
    );

    const manual = scheduler.runNow();
    await Promise.resolve();
    assert.equal(calls, 1);
    scheduler.start();
    const drain = scheduler.trigger();
    first.resolve(emptyResult);
    await Promise.all([manual, drain]);
    assert.equal(calls, 2);
    await scheduler.stop();
  });

  it("does not overlap manual worker runs", async () => {
    const first = deferred<PublicationWorkerResult[]>();
    let calls = 0;
    const scheduler = new PublicationScheduler(
      worker(async () => { calls += 1; return first.promise; }, async () => undefined)
    );

    const one = scheduler.runNow();
    const two = scheduler.runNow();
    await Promise.resolve();
    assert.equal(calls, 1);
    first.resolve(emptyResult);
    await Promise.all([one, two]);
  });

  it("uses a short fallback timer when due-time inspection fails", async () => {
    const timers = fakeTimers();
    const errors: unknown[] = [];
    const scheduler = new PublicationScheduler(
      worker(async () => emptyResult, async () => { throw new Error("database unavailable"); }),
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer, onError: (error) => errors.push(error) }
    );

    scheduler.start();
    await flush();
    assert.equal(errors.length, 1);
    assert.equal(timers.scheduled[0]?.delayMs, 30_000);
    await scheduler.stop();
  });

  it("backs off after a worker failure even when work remains due", async () => {
    const timers = fakeTimers();
    const errors: unknown[] = [];
    const scheduler = new PublicationScheduler(
      worker(async () => { throw new Error("temporary worker failure"); }, async () => new Date("2026-09-21T09:59:00.000Z")),
      {
        now: () => new Date("2026-09-21T10:00:00.000Z"),
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        onError: (error) => errors.push(error)
      }
    );

    scheduler.start();
    await flush();
    assert.equal(errors.length, 1);
    assert.equal(timers.scheduled.length, 1);
    assert.equal(timers.scheduled[0]?.delayMs, 30_000);
    await scheduler.stop();
  });

  it("does not reject when the error observer fails", async () => {
    const scheduler = new PublicationScheduler(
      worker(async () => { throw new Error("worker failure"); }, async () => undefined),
      { onError: () => { throw new Error("observer failure"); } }
    );

    assert.deepEqual(await scheduler.runNow(), []);
  });

  it("rejects an invalid error retry interval", () => {
    assert.throws(
      () => new PublicationScheduler(worker(async () => emptyResult, async () => undefined), { retryAfterErrorMs: 999 }),
      /at least one second/
    );
  });
});
