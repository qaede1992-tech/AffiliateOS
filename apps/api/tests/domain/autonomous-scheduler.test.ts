import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AutonomousCycleResult, AutonomousCycleService } from "../../src/domain/autonomous-cycle.js";
import { AutonomousScheduler } from "../../src/domain/autonomous-scheduler.js";

const result = (): AutonomousCycleResult => ({
  startedAt: "2026-09-21T00:00:00.000Z",
  completedAt: "2026-09-21T00:00:01.000Z",
  candidateCount: 1,
  execution: { selected: [], rejected: [], outcomes: [] }
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
};

describe("AutonomousScheduler", () => {
  it("runs one initial cycle on start without recurring polling", async () => {
    const first = deferred<AutonomousCycleResult | undefined>();
    let calls = 0;
    const cycle = { runOnce: async () => { calls += 1; return first.promise; } } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle);
    scheduler.start();
    scheduler.start();
    assert.equal(calls, 1);
    assert.equal(scheduler.status.running, true);
    assert.equal(scheduler.status.active, true);
    first.resolve(result());
    await scheduler.stop();
    assert.equal(calls, 1);
    assert.equal(scheduler.status.active, false);
  });

  it("runs again after an explicit work trigger", async () => {
    let calls = 0;
    const cycle = { runOnce: async () => { calls += 1; return result(); } } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle);
    scheduler.start();
    assert.equal(calls, 1);
    const output = await scheduler.trigger();
    assert.equal(calls, 2);
    assert.ok(output);
    assert.equal(scheduler.status.active, false);
    await scheduler.stop();
  });

  it("coalesces events received while a cycle is active into one follow-up run", async () => {
    const first = deferred<AutonomousCycleResult | undefined>();
    let calls = 0;
    const cycle = {
      runOnce: async () => {
        calls += 1;
        return calls === 1 ? first.promise : result();
      }
    } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle);
    scheduler.start();
    const firstTrigger = scheduler.trigger();
    await Promise.resolve();
    const secondTrigger = scheduler.trigger();
    const thirdTrigger = scheduler.trigger();
    assert.equal(calls, 1);
    assert.equal(scheduler.status.pending, true);
    first.resolve(result());
    await Promise.all([firstTrigger, secondTrigger, thirdTrigger]);
    assert.equal(calls, 2);
    assert.equal(scheduler.status.pending, false);
    await scheduler.stop();
  });

  it("does not trigger additional work after the scheduler has stopped", async () => {
    let calls = 0;
    const cycle = { runOnce: async () => { calls += 1; return result(); } } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle);
    scheduler.start();
    await scheduler.stop();
    assert.equal(await scheduler.trigger(), undefined);
    assert.equal(calls, 1);
  });

  it("does not overlap manual cycle runs and returns the active result", async () => {
    const first = deferred<AutonomousCycleResult>();
    let calls = 0;
    const cycle = { runOnce: async () => { calls += 1; return first.promise; } } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle);
    const firstRun = scheduler.runNow();
    const secondRun = scheduler.runNow();
    await Promise.resolve();
    assert.equal(calls, 1);
    const expected = result();
    first.resolve(expected);
    assert.equal(await firstRun, expected);
    assert.equal(await secondRun, expected);
  });

  it("uses a deterministic idempotency namespace for manual cycles", async () => {
    const inputs: Array<{ idempotencyNamespace?: string }> = [];
    const cycle = { runOnce: async (input: { idempotencyNamespace?: string }) => { inputs.push(input); return result(); } } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle, {}, { intervalMs: 900_000, now: () => new Date("2026-09-21T00:14:59.000Z") });
    await scheduler.runNow();
    assert.equal(inputs[0]?.idempotencyNamespace, "autonomous-cycle:1988832");
  });

  it("preserves an explicitly supplied idempotency namespace", async () => {
    const inputs: Array<{ idempotencyNamespace?: string }> = [];
    const cycle = { runOnce: async (input: { idempotencyNamespace?: string }) => { inputs.push(input); return result(); } } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle, { idempotencyNamespace: "manual-cycle" });
    await scheduler.runNow();
    assert.equal(inputs[0]?.idempotencyNamespace, "manual-cycle");
  });

  it("records execution status and reports cycle errors without throwing", async () => {
    const cycle = { runOnce: async () => { throw new Error("cycle failure"); } } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle, {}, { now: () => new Date("2026-09-21T00:00:00.000Z") });
    assert.equal(await scheduler.runNow(), undefined);
    assert.equal(scheduler.status.lastError, "cycle failure");
    assert.equal(scheduler.status.active, false);
    assert.equal(scheduler.status.lastCompletedAt, "2026-09-21T00:00:00.000Z");
  });

  it("rejects intervals below five minutes", () => {
    const cycle = { runOnce: async () => undefined } as unknown as AutonomousCycleService;
    assert.throws(() => new AutonomousScheduler(cycle, {}, { intervalMs: 299_999 }), /at least 5 minutes/);
  });

  it("records an empty-catalog skip without scheduling another run", async () => {
    const cycle = {
      runOnce: async () => undefined,
      get skipReason() { return "no_candidates" as const; }
    } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle);
    scheduler.start();
    await scheduler.stop();
    assert.equal(scheduler.status.lastSkipReason, "no_candidates");
    assert.equal(scheduler.status.pending, false);
  });

  it("records lock contention as a skip instead of an execution error", async () => {
    const cycle = {
      runOnce: async () => undefined,
      get skipReason() { return "lock_busy" as const; }
    } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle, {}, { now: () => new Date("2026-09-21T00:00:00.000Z") });
    assert.equal(await scheduler.runNow(), undefined);
    assert.equal(scheduler.status.lastSkipReason, "lock_busy");
    assert.equal(scheduler.status.lastError, undefined);
    assert.equal(scheduler.status.active, false);
  });

  it("preserves a successful cycle when the result observer fails", async () => {
    const errors: unknown[] = [];
    const output = result();
    const cycle = { runOnce: async () => output } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle, {}, {
      onResult: () => { throw new Error("observer failure"); },
      onError: (error) => errors.push(error)
    });
    assert.equal(await scheduler.runNow(), output);
    assert.equal(scheduler.status.lastResult, output);
    assert.equal(scheduler.status.lastError, undefined);
    assert.equal(errors.length, 1);
  });

  it("does not reject when the error observer itself fails", async () => {
    const cycle = { runOnce: async () => { throw new Error("cycle failure"); } } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle, {}, { onError: () => { throw new Error("error observer failure"); } });
    assert.equal(await scheduler.runNow(), undefined);
    assert.equal(scheduler.status.lastError, "cycle failure");
    assert.equal(scheduler.status.active, false);
  });

});
