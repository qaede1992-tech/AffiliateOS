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
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { candidates: unknown[] }).candidates.length, 2);
    assert.ok(new Date(result.completedAt).getTime() >= new Date(result.startedAt).getTime());
  });

  it("derives publication time from a configured delay", async () => {
    const candidates: AutonomousCandidateProvider = { async listCandidates() { return []; } };
    let scheduledAt: string | undefined;
    const execution = {
      async runOnce(input: { scheduledAt?: string }) {
        scheduledAt = input.scheduledAt;
        return { selected: [], rejected: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;

    const service = new AutonomousCycleService(candidates, execution);
    const before = Date.now();
    await service.runOnce({ publicationDelayMs: 5_000 });
    const after = Date.now();

    assert.ok(scheduledAt);
    const scheduledMs = Date.parse(scheduledAt);
    assert.ok(scheduledMs >= before + 4_500);
    assert.ok(scheduledMs <= after + 5_500);
  });

  it("rejects invalid publication delays", async () => {
    const candidates: AutonomousCandidateProvider = { async listCandidates() { return []; } };
    const execution = {
      async runOnce() {
        return { selected: [], rejected: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;
    const service = new AutonomousCycleService(candidates, execution);

    await assert.rejects(() => service.runOnce({ publicationDelayMs: -1 }), /finite non-negative/);
    await assert.rejects(() => service.runOnce({ publicationDelayMs: Number.NaN }), /finite non-negative/);
  });

  it("preserves an explicit publication time over a configured delay", async () => {
    const candidates: AutonomousCandidateProvider = { async listCandidates() { return []; } };
    let scheduledAt: string | undefined;
    const execution = {
      async runOnce(input: { scheduledAt?: string }) {
        scheduledAt = input.scheduledAt;
        return { selected: [], rejected: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;
    const service = new AutonomousCycleService(candidates, execution);

    await service.runOnce({ scheduledAt: "2026-10-01T10:00:00.000Z", publicationDelayMs: 60_000 });
    assert.equal(scheduledAt, "2026-10-01T10:00:00.000Z");
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
