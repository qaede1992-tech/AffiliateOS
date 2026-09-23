import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CampaignAnalytics } from "../../src/domain/analytics.js";
import { AutonomousOptimizationRunner } from "../../src/domain/autonomous-optimization-runner.js";
import type { AutonomousActionOutcomeWriter } from "../../src/domain/autonomous-action-outcome.js";
import type { AutonomousCampaignActionResult, AutonomousCampaignActionExecutor } from "../../src/domain/autonomous-campaign-action-executor.js";

const metrics = (campaignId: string, clicks: number, conversions: number): CampaignAnalytics => ({
  campaignId,
  clickCount: clicks,
  trackingLinkCount: 1,
  contentCount: 1,
  publishedContentCount: 1,
  scheduledContentCount: 0,
  attributedConversionCount: conversions,
  attributedRevenueCents: 10000,
  attributedCommissionCents: 500,
  conversionRate: clicks === 0 ? 0 : conversions / clicks
});

describe("AutonomousOptimizationRunner", () => {
  it("captures baseline and immediate observed metrics for an executed action", async () => {
    const baseline = metrics("c1", 100, 8);
    const observed = metrics("c1", 101, 9);
    let analyticsCalls = 0;
    const analytics = {
      async overview() { return { campaigns: [baseline], clickCount: 100, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 8, attributedRevenueCents: 10000, attributedCommissionCents: 500, conversionRate: 0.08 }; },
      async campaign() { analyticsCalls += 1; return observed; }
    };

    const outcomes: Array<{ id: string; baseline?: unknown; observed?: unknown }> = [];
    const outcomeWriter: AutonomousActionOutcomeWriter = {
      async save(outcome) { return outcome; },
      async updateMetrics(id, metrics) {
        outcomes.push({ id, ...metrics });
        return undefined;
      }
    };

    const executor = {
      async execute(recommendation: { campaignId: string; action: "scale" }) {
        return {
          campaignId: recommendation.campaignId,
          action: recommendation.action,
          campaign: {} as AutonomousCampaignActionResult["campaign"],
          mutated: true,
          outcomeId: "outcome-1"
        };
      }
    } as unknown as AutonomousCampaignActionExecutor;

    const states = new Map();
    const runner = new AutonomousOptimizationRunner(
      analytics,
      { async get(id: string) { return states.get(id); } },
      { async save(id: string, state) { states.set(id, state); } },
      executor,
      outcomeWriter
    );

    const result = await runner.run(new Date("2026-09-23T00:00:00.000Z"));

    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].outcomeId, "outcome-1");
    assert.equal(analyticsCalls, 1);
    assert.deepEqual(outcomes, [{
      id: "outcome-1",
      baseline: {
        clickCount: 100,
        attributedConversionCount: 8,
        attributedRevenueCents: 10000,
        attributedCommissionCents: 500,
        conversionRate: 0.08
      },
      observed: {
        clickCount: 101,
        attributedConversionCount: 9,
        attributedRevenueCents: 10000,
        attributedCommissionCents: 500,
        conversionRate: 9 / 101
      }
    }]);
  });

  it("does not require metric enrichment support from the outcome writer", async () => {
    const campaign = metrics("c1", 100, 8);
    const analytics = {
      async overview() { return { campaigns: [campaign], clickCount: 100, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 8, attributedRevenueCents: 10000, attributedCommissionCents: 500, conversionRate: 0.08 }; },
      async campaign() { throw new Error("should not be called"); }
    };
    const executor = {
      async execute(recommendation: { campaignId: string; action: "scale" }) {
        return {
          campaignId: recommendation.campaignId,
          action: recommendation.action,
          campaign: {} as AutonomousCampaignActionResult["campaign"],
          mutated: true,
          outcomeId: "outcome-2"
        };
      }
    } as unknown as AutonomousCampaignActionExecutor;

    const runner = new AutonomousOptimizationRunner(
      analytics,
      { async get() { return undefined; } },
      { async save() {} },
      executor,
      { async save(outcome) { return outcome; } }
    );

    const result = await runner.run();
    assert.equal(result.actions[0].outcomeId, "outcome-2");
  });

  it("keeps the action successful when post-action analytics enrichment fails", async () => {
    const campaign = metrics("c1", 100, 8);
    const analytics = {
      async overview() { return { campaigns: [campaign], clickCount: 100, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 8, attributedRevenueCents: 10000, attributedCommissionCents: 500, conversionRate: 0.08 }; },
      async campaign() { throw new Error("analytics unavailable"); }
    };
    const outcomeWriter: AutonomousActionOutcomeWriter = {
      async save(outcome) { return outcome; },
      async updateMetrics() { throw new Error("metrics write unavailable"); }
    };
    const executor = {
      async execute(recommendation: { campaignId: string; action: "scale" }) {
        return {
          campaignId: recommendation.campaignId,
          action: recommendation.action,
          campaign: {} as AutonomousCampaignActionResult["campaign"],
          mutated: true,
          outcomeId: "outcome-3"
        };
      }
    } as unknown as AutonomousCampaignActionExecutor;

    const runner = new AutonomousOptimizationRunner(
      analytics,
      { async get() { return undefined; } },
      { async save() {} },
      executor,
      outcomeWriter
    );

    const result = await runner.run();
    assert.equal(result.actions[0].mutated, true);
  });
});
