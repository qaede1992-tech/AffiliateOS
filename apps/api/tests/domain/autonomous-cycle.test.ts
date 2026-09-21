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
      createRevision: async (_campaignId: string, _source: unknown) => { created += 1; const item = { ...source, id: "revision-1", status: "draft", title: "[Revision] Original" }; revised.push(item); return item; }
    };
    const execution = { runOnce: async () => ({ selected: [], rejected: [], outcomes: [] }) } as never;
    const service = new AutonomousCycleService({ listCandidates: async () => [] }, execution, analytics, undefined, campaigns, content);
    await service.runOnce();
    await service.runOnce();
    assert.equal(created, 2);
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
