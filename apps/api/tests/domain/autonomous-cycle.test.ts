import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousCycleService, type AutonomousCandidateProvider } from "../../src/domain/autonomous-cycle.js";
import type { AutonomousExecutionService } from "../../src/domain/autonomous-execution.js";
import { InMemoryAutonomousOptimizationStateRepository } from "../../src/domain/autonomous-optimization-state.js";
import { InMemoryAutonomousCycleLockRepository } from "../../src/domain/autonomous-cycle-lock.js";

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

  it("applies pause and scale recommendations to campaign state", async () => {
    const updates: Array<{ id: string; status: string }> = [];
    const analytics = { overview: async () => ({ campaigns: [
      { campaignId: "pause-me", clickCount: 120, trackingLinkCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 0, attributedRevenueCents: 0, attributedCommissionCents: 0, conversionRate: 0 },
      { campaignId: "scale-me", clickCount: 100, trackingLinkCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 10, attributedRevenueCents: 0, attributedCommissionCents: 0, conversionRate: 0.1 }
    ] }) };
    const states: Record<string, string> = { "pause-me": "active", "scale-me": "paused" };
    const campaigns = { get: async (id: string) => ({ id, status: states[id] } as never), update: async (id: string, input: { status?: string }) => { updates.push({ id, status: input.status! }); states[id] = input.status!; return {} as never; } };
    const execution = { runOnce: async () => ({ selected: [], rejected: [], outcomes: [] }) } as never;
    const service = new AutonomousCycleService({ listCandidates: async () => [] }, execution, analytics, undefined, campaigns);
    const result = await service.runOnce();
    assert.deepEqual(updates, [{ id: "pause-me", status: "paused" }, { id: "scale-me", status: "active" }]);
    assert.equal(result?.optimization.length, 2);
  });

  it("creates one idempotent content revision for revise-content recommendations", async () => {
    let created = 0;
    const analytics = { overview: async () => ({ campaigns: [{ campaignId: "revise-me", clickCount: 40, trackingLinkCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 1, attributedRevenueCents: 0, attributedCommissionCents: 0, conversionRate: 0.025 }] }) };
    const campaigns = { update: async () => ({}) };
    const source = { id: "content-1", status: "published", campaignId: "revise-me", productId: "product-1", platform: "tiktok", contentType: "affiliate-promotion", title: "Original", caption: "Original caption", script: "Original script", cta: "Check" } as never;
    const revised: unknown[] = [];
    const content = {
      list: async () => [source, ...revised],
      createRevision: async (_campaignId: string, _source: unknown) => {
        const existing = revised.find((item) => (item as { title?: string }).title?.startsWith("[Revision] "));
        if (existing) return existing;
        created += 1;
        const item = { ...source, id: "revision-1", status: "draft", title: "[Revision] Original" };
        revised.push(item);
        return item;
      }
    };
    const execution = { runOnce: async () => ({ selected: [], rejected: [], outcomes: [] }) } as never;
    const service = new AutonomousCycleService({ listCandidates: async () => [] }, execution, analytics, undefined, campaigns, content);
    await service.runOnce();
    await service.runOnce();
    assert.equal(created, 1);
  });

  it("persists optimization cooldown across cycle service instances", async () => {
    const stateRepository = new InMemoryAutonomousOptimizationStateRepository();
    const analytics = { overview: async () => ({ campaigns: [{ campaignId: "scale-me", clickCount: 100, trackingLinkCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 10, attributedRevenueCents: 0, attributedCommissionCents: 0, conversionRate: 0.1 }] }) };
    const campaigns = { get: async (id: string) => ({ id, status: "paused" }) as never, update: async () => ({}) as never };
    const execution = { runOnce: async () => ({ selected: [], rejected: [], outcomes: [] }) } as never;

    const first = new AutonomousCycleService({ listCandidates: async () => [] }, execution, analytics, undefined, campaigns, undefined, stateRepository);
    const firstResult = await first.runOnce();
    assert.equal(firstResult?.optimization[0]?.action, "scale");

    const second = new AutonomousCycleService({ listCandidates: async () => [] }, execution, analytics, undefined, campaigns, undefined, stateRepository);
    const secondResult = await second.runOnce();
    assert.equal(secondResult?.optimization[0]?.action, "maintain");
    assert.match(secondResult?.optimization[0]?.reasons[0] ?? "", /cooldown active/i);
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

  it("does not apply a stale optimization when compare-and-set loses a race", async () => {
    let updates = 0;
    let casCalls = 0;
    const newerState = { action: "pause" as const, appliedAt: "2026-09-21T10:00:00.000Z" };
    const stateRepository = {
      get: async () => newerState,
      save: async (_id: string, state: typeof newerState) => state,
      compareAndSet: async () => {
        casCalls += 1;
        return false;
      }
    };
    const analytics = { overview: async () => ({ campaigns: [{
      campaignId: "race-me",
      clickCount: 100,
      trackingLinkCount: 1,
      contentCount: 1,
      publishedContentCount: 1,
      scheduledContentCount: 0,
      attributedConversionCount: 10,
      attributedRevenueCents: 0,
      attributedCommissionCents: 0,
      conversionRate: 0.1
    }] }) };
    const campaigns = {
      get: async (id: string) => ({ id, status: "paused" }) as never,
      update: async () => { updates += 1; return {} as never; }
    };
    const execution = { runOnce: async () => ({ selected: [], rejected: [], outcomes: [] }) } as never;

    const service = new AutonomousCycleService(
      { listCandidates: async () => [] },
      execution,
      analytics,
      undefined,
      campaigns,
      undefined,
      stateRepository
    );
    const result = await service.runOnce();

    assert.equal(casCalls, 1);
    assert.equal(updates, 0);
    assert.equal(result?.optimization.length, 1);
    assert.equal(result?.optimization[0]?.action, "scale");
  });

  it("skips a cycle when the distributed lock is held by another instance", async () => {
    const lock = new InMemoryAutonomousCycleLockRepository();
    const now = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + 60_000).toISOString();
    assert.equal(await lock.tryAcquire("autonomous-cycle", "other-instance", now, leaseUntil), true);

    let executed = 0;
    const execution = { runOnce: async () => { executed += 1; return { selected: [], rejected: [], outcomes: [] }; } } as never;
    const service = new AutonomousCycleService(
      { listCandidates: async () => [] },
      execution,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lock
    );

    const result = await service.runOnce();
    assert.equal(result, undefined);
    assert.equal(executed, 0);
  });

  it("aborts before optimization when distributed lock renewal is lost", async () => {
    let renewCalls = 0;
    let analyticsCalls = 0;
    const lock = {
      tryAcquire: async () => true,
      renew: async () => {
        renewCalls += 1;
        return false;
      },
      release: async () => {}
    };
    const execution = {
      runOnce: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { selected: [], rejected: [], outcomes: [] };
      }
    } as unknown as AutonomousExecutionService;
    const analytics = {
      overview: async () => {
        analyticsCalls += 1;
        return { campaigns: [] };
      }
    };

    const service = new AutonomousCycleService(
      { listCandidates: async () => [] },
      execution,
      analytics,
      undefined,
      undefined,
      undefined,
      undefined,
      lock,
      "autonomous-cycle-test",
      { leaseMs: 100, renewMs: 5 }
    );

    await assert.rejects(() => service.runOnce(), (error: unknown) => {
      return error instanceof Error && error.name === "AutonomousCycleLockLostError";
    });
    assert.ok(renewCalls > 0);
    assert.equal(analyticsCalls, 0);
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
