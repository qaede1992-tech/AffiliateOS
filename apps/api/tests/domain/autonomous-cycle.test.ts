import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousCycleService, type AutonomousCandidateProvider } from "../../src/domain/autonomous-cycle.js";
import type { AutonomousExecutionService } from "../../src/domain/autonomous-execution.js";

describe("autonomous cycle", () => {
  it("loads candidates and delegates one execution pass", async () => {
    const candidates: AutonomousCandidateProvider = {
      async listCandidates() {
        return [
          { product: { id: "product-1" } as never, offers: [] },
          { product: { id: "product-2" } as never, offers: [] }
        ];
      }
    };
    const calls: unknown[] = [];
    const execution = {
      async runOnce(input: { candidates: unknown[] }) {
        calls.push(input);
        return { selected: [], rejected: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;

    const service = new AutonomousCycleService(candidates, execution);
    const result = await service.runOnce({ idempotencyNamespace: "cycle-test" });

    assert.ok(result);
    assert.equal(result.candidateCount, 2);
    assert.equal(result.execution.outcomes.length, 0);
    assert.deepEqual(result.optimization, []);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { candidates: unknown[] }).candidates.length, 2);
    assert.ok(new Date(result.completedAt).getTime() >= new Date(result.startedAt).getTime());
  });

  it("derives a future publication time when a delay is configured", async () => {
    const execution = { async runOnce(input: { scheduledAt?: string }) { assert.ok(input.scheduledAt); assert.ok(new Date(input.scheduledAt).getTime() > Date.now()); return { selected: [], rejected: [], outcomes: [] }; } } as unknown as AutonomousExecutionService;
    const service = new AutonomousCycleService({ listCandidates: async () => [] }, execution);
    await service.runOnce({ publicationDelayMs: 60_000 });
  });

  it("prevents overlapping cycles and releases the guard after completion", async () => {
    let release!: () => void;
    const candidates: AutonomousCandidateProvider = {
      async listCandidates() {
        return [{ product: { id: "product-1" } as never, offers: [] }];
      }
    };
    const execution = {
      runOnce: () => new Promise<{ selected: never[]; rejected: never[]; outcomes: never[] }>((resolve) => {
        release = () => resolve({ selected: [], rejected: [], outcomes: [] });
      })
    } as unknown as AutonomousExecutionService;

    const service = new AutonomousCycleService(candidates, execution);
    const first = service.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    const overlapping = await service.runOnce();
    assert.equal(overlapping, undefined);

    release();
    assert.ok(await first);
    assert.ok(await service.runOnce());
  });

  it("releases the guard when candidate loading fails", async () => {
    let attempts = 0;
    const candidates: AutonomousCandidateProvider = {
      async listCandidates() {
        attempts += 1;
        if (attempts === 1) throw new Error("catalog unavailable");
        return [];
      }
    };
    const execution = {
      async runOnce() {
        return { selected: [], rejected: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;

    const service = new AutonomousCycleService(candidates, execution);
    await assert.rejects(() => service.runOnce(), /catalog unavailable/);
    const second = await service.runOnce();
    assert.ok(second);
    assert.equal(second.candidateCount, 0);
  });
});
