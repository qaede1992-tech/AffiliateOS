import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PublicationWorker } from "../../src/domain/publication-worker.js";
import { PublicationScheduler } from "../../src/domain/publication-scheduler.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
};

describe("PublicationScheduler", () => {
  it("does not overlap worker runs", async () => {
    const first = deferred<void>();
    let calls = 0;
    const worker = {
      runOnce: async () => {
        calls += 1;
        if (calls === 1) await first.promise;
        return [];
      }
    } as unknown as PublicationWorker;
    const scheduler = new PublicationScheduler(worker);

    const firstRun = scheduler.runNow(new Date("2026-09-20T11:00:00.000Z"));
    const secondRun = scheduler.runNow(new Date("2026-09-20T11:00:01.000Z"));
    let secondSettled = false;
    void secondRun.finally(() => { secondSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(secondSettled, false);
    assert.equal(calls, 1);
    first.resolve();
    await Promise.all([firstRun, secondRun]);
    assert.equal(calls, 1);
  });

  it("reports worker errors without stopping the scheduler", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const worker = {
      runOnce: async () => {
        calls += 1;
        if (calls === 1) throw new Error("worker failure");
        return [];
      }
    } as unknown as PublicationWorker;
    const scheduler = new PublicationScheduler(worker, { onError: (error) => errors.push(error) });

    await scheduler.runNow();
    await scheduler.runNow();

    assert.equal(calls, 2);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, "worker failure");
  });

  it("preserves successful worker completion when the result observer fails", async () => {
    const errors: unknown[] = [];
    const results = [{ jobId: "job-1", status: "completed" }];
    const worker = { runOnce: async () => results } as unknown as PublicationWorker;
    const scheduler = new PublicationScheduler(worker, {
      onResults: () => { throw new Error("observer failure"); },
      onError: (error) => errors.push(error)
    });

    await scheduler.runNow();

    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, "observer failure");
  });

  it("does not reject when the error observer itself fails", async () => {
    const worker = { runOnce: async () => { throw new Error("worker failure"); } } as unknown as PublicationWorker;
    const scheduler = new PublicationScheduler(worker, {
      onError: () => { throw new Error("error observer failure"); }
    });

    await scheduler.runNow();
  });

  it("starts an immediate run and stops cleanly while a run is active", async () => {
    const first = deferred<void>();
    let calls = 0;
    const worker = {
      runOnce: async () => {
        calls += 1;
        await first.promise;
        return [];
      }
    } as unknown as PublicationWorker;
    const scheduler = new PublicationScheduler(worker, { intervalMs: 60_000 });

    scheduler.start();
    await Promise.resolve();
    assert.equal(scheduler.isRunning, true);
    assert.equal(calls, 1);

    const stopping = scheduler.stop();
    first.resolve();
    await stopping;

    assert.equal(scheduler.isRunning, false);
  });

  it("rejects invalid intervals", () => {
    const worker = { runOnce: async () => [] } as unknown as PublicationWorker;
    assert.throws(() => new PublicationScheduler(worker, { intervalMs: 0 }), /positive finite/);
    assert.throws(() => new PublicationScheduler(worker, { intervalMs: Number.NaN }), /positive finite/);
  });
});
