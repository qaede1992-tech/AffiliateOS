import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AutonomousCycleResult, AutonomousCycleService } from "../../src/domain/autonomous-cycle.js";
import { AutonomousScheduler } from "../../src/domain/autonomous-scheduler.js";

const result = (id: string): AutonomousCycleResult => ({
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
  it("does not overlap cycle runs and returns the active result", async () => {
    const first = deferred<AutonomousCycleResult>();
    let calls = 0;
    const cycle = {
      runOnce: async () => {
        calls += 1;
        return first.promise;
      }
    } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle);

    const firstRun = scheduler.runNow();
    const secondRun = scheduler.runNow();
    await Promise.resolve();
    assert.equal(calls, 1);

    const expected = result("first");
    first.resolve(expected);
    assert.equal(await firstRun, expected);
    assert.equal(await secondRun, expected);
  });

  it("uses a deterministic interval bucket namespace for scheduled cycles", async () => {
    const inputs: Array<{ idempotencyNamespace?: string }> = [];
    const cycle = {
      runOnce: async (input: { idempotencyNamespace?: string }) => {
        inputs.push(input);
        return result("scheduled");
      }
    } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle, {}, {
      intervalMs: 900_000,
      now: () => new Date("2026-09-21T00:14:59.000Z")
    });

    scheduler.start();
    await scheduler.stop();

    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].idempotencyNamespace, "autonomous-cycle:196175609");
  });

  it("preserves an explicitly supplied idempotency namespace", async () => {
    const inputs: Array<{ idempotencyNamespace?: string }> = [];
    const cycle = {
      runOnce: async (input: { idempotencyNamespace?: string }) => {
        inputs.push(input);
        return result("explicit");
      }
    } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle, { idempotencyNamespace: "manual-cycle" }, { intervalMs: 900_000 });

    scheduler.start();
    await scheduler.stop();

    assert.equal(inputs[0].idempotencyNamespace, "manual-cycle");
  });

  it("reports scheduler errors through the error callback", async () => {
    const errors: unknown[] = [];
    const cycle = {
      runOnce: async () => { throw new Error("cycle failure"); }
    } as unknown as AutonomousCycleService;
    const scheduler = new AutonomousScheduler(cycle, {}, { onError: (error) => errors.push(error) });

    assert.equal(await scheduler.runNow(), undefined);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, "cycle failure");
  });

  it("rejects invalid intervals", () => {
    const cycle = { runOnce: async () => undefined } as unknown as AutonomousCycleService;
    assert.throws(() => new AutonomousScheduler(cycle, {}, { intervalMs: 0 }), /positive finite/);
    assert.throws(() => new AutonomousScheduler(cycle, {}, { intervalMs: Number.NaN }), /positive finite/);
  });
});
