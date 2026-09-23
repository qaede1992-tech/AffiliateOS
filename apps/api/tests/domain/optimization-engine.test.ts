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

  it("requires commission efficiency for scale when configured", () => {
    const lowEfficiency = new OptimizationEngine({ minimumCommissionPerClickCents: 10 }).recommend([analytics("c-low", 100, 0.08)]);
    assert.equal(lowEfficiency[0].action, "revise-content");
    const efficient = new OptimizationEngine({ minimumCommissionPerClickCents: 4 }).recommend([analytics("c-high", 100, 0.08)]);
    assert.equal(efficient[0].action, "scale");
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

  it("recommends creative revision for intermediate performance", () => {
    const result = new OptimizationEngine().recommend([analytics("c1", 80, 0.025)]);
    assert.equal(result[0].action, "revise-content");
  });

  it("holds recommendations during the configured cooldown", () => {
    const engine = new OptimizationEngine({ cooldownMs: 60 * 60_000 });
    const state = new Map([
      ["c1", { action: "scale" as const, appliedAt: "2026-09-22T10:00:00.000Z" }]
    ]);
    const result = engine.recommend(
      [analytics("c1", 200, 0.1)],
      state,
      new Date("2026-09-22T10:30:00.000Z")
    );
    assert.equal(result[0].action, "maintain");
    assert.match(result[0].reasons[0], /cooldown/i);
  });

  it("allows a new recommendation after the cooldown expires", () => {
    const engine = new OptimizationEngine({ cooldownMs: 60 * 60_000 });
    const state = new Map([
      ["c1", { action: "maintain" as const, appliedAt: "2026-09-22T10:00:00.000Z" }]
    ]);
    const result = engine.recommend(
      [analytics("c1", 200, 0.1)],
      state,
      new Date("2026-09-22T11:01:00.000Z")
    );
    assert.equal(result[0].action, "scale");
  });
});
