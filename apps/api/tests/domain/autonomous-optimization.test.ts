import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousOptimizationService, InMemoryOptimizationStateReader } from "../../src/domain/autonomous-optimization.js";
import type { AnalyticsOverview } from "../../src/domain/analytics.js";

const campaign = {
  campaignId: "campaign-1",
  productId: "product-1",
  clickCount: 40,
  trackingLinkCount: 1,
  contentCount: 1,
  publishedContentCount: 1,
  scheduledContentCount: 0,
  attributedConversionCount: 4,
  attributedRevenueCents: 40000,
  attributedCommissionCents: 4000,
  conversionRate: 0.1
};

const analytics = (campaigns = [campaign]): Pick<AnalyticsOverview, "campaigns"> => ({ campaigns });

describe("AutonomousOptimizationService", () => {
  it("returns optimization decisions from analytics without mutating execution state", async () => {
    const service = new AutonomousOptimizationService({ overview: async () => analytics() });

    const result = await service.recommend(new Date("2026-09-22T00:00:00.000Z"));

    assert.deepEqual(result.campaigns, [campaign]);
    assert.equal(result.recommendations.length, 1);
    assert.equal(result.recommendations[0].campaignId, "campaign-1");
    assert.equal(result.recommendations[0].action, "scale");
  });

  it("honors existing optimization state through the decision boundary", async () => {
    const state = new InMemoryOptimizationStateReader(new Map([
      ["campaign-1", { action: "scale", appliedAt: "2026-09-22T00:00:00.000Z" }]
    ]));
    const service = new AutonomousOptimizationService(
      { overview: async () => analytics() },
      { cooldownMs: 60 * 60_000 },
      state
    );

    const result = await service.recommend(new Date("2026-09-22T00:30:00.000Z"));

    assert.equal(result.recommendations[0].campaignId, "campaign-1");
    assert.equal(result.recommendations[0].action, "maintain");
  });

  it("keeps empty analytics safe and decision-only", async () => {
    const service = new AutonomousOptimizationService({ overview: async () => analytics([]) });

    const result = await service.recommend();

    assert.deepEqual(result.campaigns, []);
    assert.deepEqual(result.recommendations, []);
  });
});
