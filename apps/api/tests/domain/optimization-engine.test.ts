import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OptimizationEngine } from "../../src/domain/optimization-engine.js";
import type { CampaignAnalytics } from "../../src/domain/analytics.js";

const analytics = (campaignId: string, clicks: number, rate: number): CampaignAnalytics => ({
  campaignId, clickCount: clicks, trackingLinkCount: 1, contentCount: 1,
  publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: Math.round(clicks * rate),
  attributedRevenueCents: 10000, attributedCommissionCents: 500, conversionRate: rate
});

describe("OptimizationEngine", () => {
  it("does not optimize before sufficient evidence", () => {
    const result = new OptimizationEngine().recommend([analytics("c1", 10, 0.2)]);
    assert.equal(result[0].action, "maintain");
  });

  it("recommends scaling campaigns above the conversion threshold", () => {
    const result = new OptimizationEngine().recommend([analytics("c1", 100, 0.08)]);
    assert.equal(result[0].action, "scale");
    assert.ok(result[0].confidence >= 1);
  });

  it("recommends pausing high-volume underperformers", () => {
    const result = new OptimizationEngine().recommend([analytics("c1", 120, 0)]);
    assert.equal(result[0].action, "pause");
  });

  it("suppresses repeated decisions during cooldown", () => {
    const now = new Date("2026-09-21T12:00:00.000Z");
    const result = new OptimizationEngine({ cooldownMs: 60 * 60_000 }).recommend([analytics("c1", 120, 0)], new Map([["c1", { action: "pause", appliedAt: "2026-09-21T11:30:00.000Z" }]]), now);
    assert.equal(result[0].action, "maintain");
    assert.match(result[0].reasons[0], /cooldown/i);
  });

  it("recommends creative revision for intermediate performance", () => {
    const result = new OptimizationEngine().recommend([analytics("c1", 80, 0.025)]);
    assert.equal(result[0].action, "revise-content");
  });
});
