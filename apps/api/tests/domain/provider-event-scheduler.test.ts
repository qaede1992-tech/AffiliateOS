import assert from "node:assert/strict";
import test from "node:test";
import { ProviderEventScheduler } from "../../src/domain/provider-event-scheduler.js";

type FakeTimer = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
  unref: () => void;
};

function createTimerHarness() {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimer(callback: () => void, delayMs: number) {
      const timer: FakeTimer = { callback, delayMs, cleared: false, unref: () => undefined };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(handle: ReturnType<typeof setTimeout>) {
      (handle as unknown as FakeTimer).cleared = true;
    },
    pending() {
      return timers.filter((timer) => !timer.cleared);
    },
    async fireNext() {
      const timer = timers.find((candidate) => !candidate.cleared);
      assert.ok(timer, "expected a scheduled timer");
      timer.cleared = true;
      timer.callback();
      await flush();
    }
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("provider event scheduler does not poll an empty queue", async () => {
  let lookups = 0;
  let calls = 0;
  const timers = createTimerHarness();
  const scheduler = new ProviderEventScheduler({
    nextWakeAt: async () => { lookups += 1; return undefined; },
    runOnce: async () => { calls += 1; return { scanned: 0, processed: 0, failed: 0 }; }
  }, { setTimer: timers.setTimer, clearTimer: timers.clearTimer });

  scheduler.start();
  await flush();

  assert.equal(lookups, 1);
  assert.equal(calls, 0);
  assert.equal(timers.pending().length, 0);
  await scheduler.stop();
});

test("provider event scheduler wakes immediately when a persisted event arrives", async () => {
  let nextWakeAt: Date | undefined;
  let calls = 0;
  const timers = createTimerHarness();
  const scheduler = new ProviderEventScheduler({
    nextWakeAt: async () => nextWakeAt,
    runOnce: async () => {
      calls += 1;
      nextWakeAt = undefined;
      return { scanned: 1, processed: 1, failed: 0 };
    }
  }, {
    now: () => new Date(0),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });

  scheduler.start();
  await flush();
  assert.equal(timers.pending().length, 0);

  nextWakeAt = new Date(0);
  scheduler.notifyChanged();
  await flush();
  assert.equal(timers.pending()[0]?.delayMs, 0);

  await timers.fireNext();
  assert.equal(calls, 1);
  assert.equal(timers.pending().length, 0);
  await scheduler.stop();
});

test("provider event scheduler schedules a future retry at the store wake time", async () => {
  const timers = createTimerHarness();
  const scheduler = new ProviderEventScheduler({
    nextWakeAt: async () => new Date(5_000),
    runOnce: async () => ({ scanned: 0, processed: 0, failed: 0 })
  }, {
    now: () => new Date(0),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });

  scheduler.start();
  await flush();
  assert.equal(timers.pending()[0]?.delayMs, 5_000);
  await scheduler.stop();
  assert.equal(timers.pending().length, 0);
});

test("provider event scheduler retries a worker failure without restoring idle polling", async () => {
  const timers = createTimerHarness();
  const scheduler = new ProviderEventScheduler({
    nextWakeAt: async () => new Date(0),
    runOnce: async () => { throw new Error("temporary database failure"); }
  }, {
    intervalMs: 10_000,
    now: () => new Date(0),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });

  scheduler.start();
  await flush();
  await timers.fireNext();
  assert.equal(timers.pending()[0]?.delayMs, 10_000);
  await scheduler.stop();
});

test("provider event scheduler prevents overlapping manual runs", async () => {
  let calls = 0;
  let release!: () => void;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const worker = {
    nextWakeAt: async () => undefined,
    runOnce: async () => {
      calls += 1;
      resolveStarted();
      await new Promise<void>((resolve) => { release = resolve; });
      return { scanned: 1, processed: 1, failed: 0 };
    }
  };
  const scheduler = new ProviderEventScheduler(worker);

  const first = scheduler.runNow();
  await started;
  const second = scheduler.runNow();
  let secondSettled = false;
  void second.finally(() => { secondSettled = true; });
  await flush();
  assert.equal(secondSettled, false);
  assert.equal(calls, 1);

  release();
  assert.deepEqual(await first, { scanned: 1, processed: 1, failed: 0 });
  assert.deepEqual(await second, { scanned: 1, processed: 1, failed: 0 });
  assert.equal(calls, 1);
});

test("provider event scheduler preserves worker success when result observer fails", async () => {
  const errors: unknown[] = [];
  const scheduler = new ProviderEventScheduler({
    nextWakeAt: async () => undefined,
    runOnce: async () => ({ scanned: 1, processed: 1, failed: 0 })
  }, {
    onResult: () => { throw new Error("result observer failure"); },
    onError: (error) => errors.push(error)
  });

  assert.deepEqual(await scheduler.runNow(), { scanned: 1, processed: 1, failed: 0 });
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "result observer failure");
});

test("provider event scheduler does not reject because error observer fails", async () => {
  const scheduler = new ProviderEventScheduler({
    nextWakeAt: async () => undefined,
    runOnce: async () => { throw new Error("worker failure"); }
  }, { onError: () => { throw new Error("error observer failure"); } });

  await assert.rejects(scheduler.runNow(), /worker failure/);
});

test("provider event scheduler stores only a safe error type in status", async () => {
  const marker = "private-provider-event-db-marker";
  const databaseError = new Error(\`Failed query: SELECT * FROM provider_events; params: \${marker}\`);
  databaseError.name = "DatabaseError";
  const scheduler = new ProviderEventScheduler({
    nextWakeAt: async () => undefined,
    runOnce: async () => { throw databaseError; }
  });

  await assert.rejects(scheduler.runNow());
  assert.equal(scheduler.status.lastError, "DatabaseError");
  assert.doesNotMatch(scheduler.status.lastError ?? "", /Failed query|params:|private-provider-event-db-marker/i);
});
