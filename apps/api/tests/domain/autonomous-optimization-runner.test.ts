import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CampaignAnalytics } from "../../src/domain/analytics.js";
import { AutonomousOptimizationRunner } from "../../src/domain/autonomous-optimization-runner.js";
import type { AutonomousActionOutcomeWriter } from "../../src/domain/autonomous-action-outcome.js";
import type { AutonomousCampaignActionResult, AutonomousCampaignActionExecutor } from "../../src/domain/autonomous-campaign-action-executor.js";

const metrics = (campaignId: string, clicks: number, conversions: number): CampaignAnalytics => ({
  campaignId, clickCount: clicks, trackingLinkCount: 1, contentCount: 1,
  publishedContentCount: 1, scheduledContentCount: 0,
  attributedConversionCount: conversions, attributedRevenueCents: 10000,
  attributedCommissionCents: 500, conversionRate: clicks === 0 ? 0 : conversions / clicks
  it("feeds delayed evaluation into the next optimization recommendation", async () => {
    const campaign = metrics("c1", 200, 16);
    let savedState: any;
    const analytics = { async overview() { return overview(campaign); }, async campaign() { return campaign; } };
    const outcomeWriter: AutonomousActionOutcomeWriter = {
      async save(outcome) { return outcome; },
      async latestByCampaign() {
        return {
          id: "outcome-feedback", campaignId: "c1", action: "scale", status: "mutated", mutated: true,
          observedAt: "2026-09-21T00:00:00.000Z",
          baseline: { clickCount: 100, attributedConversionCount: 10, attributedRevenueCents: 10000, attributedCommissionCents: 500, conversionRate: 0.1 }
        };
      },
      async updateEvaluation() { return undefined; }
    };
    const runner = new AutonomousOptimizationRunner(
      analytics,
      { async get() { return { action: "scale", appliedAt: "2026-09-21T00:00:00.000Z" }; } },
      { async save(_id, state) { savedState = state; } },
      executorFor("new-action"),
      outcomeWriter,
      {},
      60 * 60_000
    );
    const result = await runner.run(new Date("2026-09-23T02:00:00.000Z"));
    assert.equal(result.recommendations[0].action, "revise-content");
    assert.equal(savedState.action, "revise-content");
  });
});

const overview = (campaign: CampaignAnalytics) => ({
  campaigns: [campaign], clickCount: campaign.clickCount, trackingLinkCount: campaign.trackingLinkCount,
  campaignCount: 1, contentCount: campaign.contentCount, publishedContentCount: campaign.publishedContentCount,
  scheduledContentCount: campaign.scheduledContentCount, attributedConversionCount: campaign.attributedConversionCount,
  attributedRevenueCents: campaign.attributedRevenueCents, attributedCommissionCents: campaign.attributedCommissionCents,
  conversionRate: campaign.conversionRate
});

const executorFor = (outcomeId: string): AutonomousCampaignActionExecutor => ({
  async execute(recommendation: { campaignId: string; action: "scale" }) {
    return {
      campaignId: recommendation.campaignId, action: recommendation.action,
      campaign: {} as AutonomousCampaignActionResult["campaign"], mutated: true, outcomeId
    };
  }
} as unknown as AutonomousCampaignActionExecutor);

describe("AutonomousOptimizationRunner", () => {
  it("captures baseline and immediate observed metrics for an executed action", async () => {
    const baseline = metrics("c1", 100, 8);
    const observed = metrics("c1", 101, 9);
    let analyticsCalls = 0;
    const analytics = {
      async overview() { return overview(baseline); },
      async campaign() { analyticsCalls += 1; return observed; }
    };
    const outcomes: Array<{ id: string; baseline?: unknown; observed?: unknown }> = [];
    const outcomeWriter: AutonomousActionOutcomeWriter = {
      async save(outcome) { return outcome; },
      async updateMetrics(id, values) { outcomes.push({ id, ...values }); return undefined; }
    };
    const runner = new AutonomousOptimizationRunner(
      analytics, { async get() { return undefined; } }, { async save() {} },
      executorFor("outcome-1"), outcomeWriter
    );
    const result = await runner.run(new Date("2026-09-23T00:00:00.000Z"));
    assert.equal(result.actions[0].outcomeId, "outcome-1");
    assert.equal(analyticsCalls, 1);
    assert.deepEqual(outcomes[0], {
      id: "outcome-1",
      baseline: { clickCount: 100, attributedConversionCount: 8, attributedRevenueCents: 10000, attributedCommissionCents: 500, conversionRate: 0.08 },
      observed: { clickCount: 101, attributedConversionCount: 9, attributedRevenueCents: 10000, attributedCommissionCents: 500, conversionRate: 9 / 101 }
    });
  });

  it("does not require metric enrichment support from the outcome writer", async () => {
    const campaign = metrics("c1", 100, 8);
    const outcomeWriter: AutonomousActionOutcomeWriter = { async save(outcome) { return outcome; } };
    const analytics = { async overview() { return overview(campaign); }, async campaign() { throw new Error("should not be called"); } };
    const runner = new AutonomousOptimizationRunner(
      analytics, { async get() { return undefined; } }, { async save() {} },
      executorFor("outcome-2"), outcomeWriter
    );
    const result = await runner.run();
    assert.equal(result.actions[0].outcomeId, "outcome-2");
  });

  it("keeps the action successful when post-action analytics enrichment fails", async () => {
    const campaign = metrics("c1", 100, 8);
    const outcomeWriter: AutonomousActionOutcomeWriter = {
      async save(outcome) { return outcome; },
      async updateMetrics() { throw new Error("metrics write unavailable"); }
    };
    const analytics = { async overview() { return overview(campaign); }, async campaign() { throw new Error("analytics unavailable"); } };
    const runner = new AutonomousOptimizationRunner(
      analytics, { async get() { return undefined; } }, { async save() {} },
      executorFor("outcome-3"), outcomeWriter
    );
    const result = await runner.run();
    assert.equal(result.actions[0].mutated, true);
  });

  it("evaluates a completed action after the evidence delay", async () => {
    const campaign = metrics("c1", 140, 7);
    const updates: Array<{ id: string; evaluatedAt: string }> = [];
    const analytics = { async overview() { return overview(campaign); }, async campaign() { return campaign; } };
    const outcomeWriter: AutonomousActionOutcomeWriter = {
      async save(outcome) { return outcome; },
      async latestByCampaign() {
        return { id: "outcome-old", campaignId: "c1", action: "scale", status: "mutated", mutated: true, observedAt: "2026-09-22T00:00:00.000Z" };
      },
      async updateEvaluation(id, _evaluation, evaluatedAt) { updates.push({ id, evaluatedAt }); return undefined; }
    };
    const runner = new AutonomousOptimizationRunner(
      analytics, { async get() { return undefined; } }, { async save() {} },
      { async execute() { throw new Error("no new action expected"); } } as unknown as AutonomousCampaignActionExecutor,
      outcomeWriter, {}, 60 * 60_000
    );
    await runner.run(new Date("2026-09-23T02:00:00.000Z"));
    assert.deepEqual(updates, [{ id: "outcome-old", evaluatedAt: "2026-09-23T02:00:00.000Z" }]);
  });

  it("does not evaluate an action before the evidence delay", async () => {
    const campaign = metrics("c1", 140, 7);
    let evaluated = false;
    const analytics = { async overview() { return overview(campaign); }, async campaign() { return campaign; } };
    const outcomeWriter: AutonomousActionOutcomeWriter = {
      async save(outcome) { return outcome; },
      async latestByCampaign() {
        return { id: "outcome-new", campaignId: "c1", action: "scale", status: "mutated", mutated: true, observedAt: "2026-09-23T01:30:00.000Z" };
      },
      async updateEvaluation() { evaluated = true; return undefined; }
    };
    const runner = new AutonomousOptimizationRunner(
      analytics, { async get() { return undefined; } }, { async save() {} },
      { async execute() { throw new Error("no new action expected"); } } as unknown as AutonomousCampaignActionExecutor,
      outcomeWriter, {}, 60 * 60_000
    );
    await runner.run(new Date("2026-09-23T02:00:00.000Z"));
    assert.equal(evaluated, false);
  });
  it("feeds delayed evaluation into the next optimization recommendation", async () => {
    const campaign = metrics("c1", 200, 16);
    let savedState: any;
    const analytics = { async overview() { return overview(campaign); }, async campaign() { return campaign; } };
    const outcomeWriter: AutonomousActionOutcomeWriter = {
      async save(outcome) { return outcome; },
      async latestByCampaign() {
        return {
          id: "outcome-feedback", campaignId: "c1", action: "scale", status: "mutated", mutated: true,
          observedAt: "2026-09-21T00:00:00.000Z",
          baseline: { clickCount: 100, attributedConversionCount: 10, attributedRevenueCents: 10000, attributedCommissionCents: 500, conversionRate: 0.1 }
        };
      },
      async updateEvaluation() { return undefined; }
    };
    const runner = new AutonomousOptimizationRunner(
      analytics,
      { async get() { return { action: "scale", appliedAt: "2026-09-21T00:00:00.000Z" }; } },
      { async save(_id, state) { savedState = state; } },
      executorFor("new-action"),
      outcomeWriter,
      {},
      60 * 60_000
    );
    const result = await runner.run(new Date("2026-09-23T02:00:00.000Z"));
    assert.equal(result.recommendations[0].action, "revise-content");
    assert.equal(savedState.action, "revise-content");
  });
});
