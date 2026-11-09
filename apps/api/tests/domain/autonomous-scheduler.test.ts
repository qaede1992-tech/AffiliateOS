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
  it("starts without scanning or running a cycle", async () => {
    let calls = 0;
    const cycle = { runOnce: async () => { calls += 1; return result(); } } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle);
    scheduler.start();
    await Promise.resolve();
    assert.equal(calls, 0);
    assert.equal(scheduler.status.running, true);
    assert.equal(scheduler.status.active, false);
    await scheduler.stop();
  });

  it("runs only after an explicit work trigger", async () => {
    let calls = 0;
    const cycle = { runOnce: async () => { calls += 1; return result(); } } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle);
    scheduler.start();
    assert.equal(calls, 0);
    const output = await scheduler.trigger();
    assert.equal(calls, 1);
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
    first.resolve(result());
    await Promise.all([firstTrigger, secondTrigger, thirdTrigger]);
    assert.equal(calls, 2);
    await scheduler.stop();
  });

  it("does not trigger work after the scheduler has stopped", async () => {
    let calls = 0;
    const cycle = { runOnce: async () => { calls += 1; return result(); } } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle);
    scheduler.start();
    await scheduler.stop();
    assert.equal(await scheduler.trigger(), undefined);
    assert.equal(calls, 0);
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
});
