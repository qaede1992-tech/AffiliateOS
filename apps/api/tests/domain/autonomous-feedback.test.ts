import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSignals, AutonomousAnalyticsFeedbackProvider } from "../../src/domain/autonomous-feedback.js";
import { InMemoryAutonomousFeedbackMemoryRepository } from "../../src/domain/autonomous-feedback-memory.js";

const campaign = (productId: string, clicks: number, conversions: number, commission = 0) => ({
  campaignId: `${productId}-campaign`, productId, clickCount: clicks, trackingLinkCount: 1, contentCount: 1,
  publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: conversions,
  attributedRevenueCents: conversions * 10000, attributedCommissionCents: commission, conversionRate: clicks ? conversions / clicks : 0
});

describe("Autonomous analytics feedback", () => {
  it("does not adjust products without enough click evidence", () => {
    const signals = buildSignals({ clickCount: 10, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 1, attributedRevenueCents: 10000, attributedCommissionCents: 500, conversionRate: 0.1, campaigns: [campaign("p1", 10, 1, 500)] });
    assert.equal(signals.get("p1")?.adjustment, 0);
  });

  it("boosts products with materially strong conversion performance", () => {
    const signals = buildSignals({ clickCount: 100, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 10, attributedRevenueCents: 100000, attributedCommissionCents: 5000, conversionRate: 0.1, campaigns: [campaign("p1", 100, 10, 5000)] });
    assert.equal(signals.get("p1")?.adjustment, 8);
  });

  it("penalizes products with weak conversion performance", () => {
    const signals = buildSignals({ clickCount: 100, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 0, attributedRevenueCents: 0, attributedCommissionCents: 0, conversionRate: 0, campaigns: [campaign("p1", 100, 0)] });
    assert.equal(signals.get("p1")?.adjustment, -8);
  });

  it("persists the exact attributed conversion count instead of reconstructing it from the rate", async () => {
    const memory = new InMemoryAutonomousFeedbackMemoryRepository();
    const provider = new AutonomousAnalyticsFeedbackProvider(
      {
        overview: async () => ({
          clickCount: 3, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1,
          scheduledContentCount: 0, attributedConversionCount: 1, attributedRevenueCents: 10000,
          attributedCommissionCents: 5000, conversionRate: 0.5,
          campaigns: [{ ...campaign("p1", 3, 1, 5000), conversionRate: 0.5 }]
        })
      },
      memory,
      () => new Date("2026-09-21T01:00:00.000Z")
    );

    await provider.getSignals();
    const snapshot = await memory.latestByProduct("p1");
    assert.ok(snapshot);
    assert.equal(snapshot.conversionCount, 1);
  });

  it("persists snapshots and applies a bounded incremental trend adjustment", async () => {
    const memory = new InMemoryAutonomousFeedbackMemoryRepository();
    let current = { clickCount: 100, conversions: 2 };
    const provider = new AutonomousAnalyticsFeedbackProvider(
      { overview: async () => ({ ...current, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: current.conversions, attributedRevenueCents: 100000, attributedCommissionCents: 10000, conversionRate: current.conversions / current.clickCount, campaigns: [campaign("p1", current.clickCount, current.conversions, 10000)] }) },
      memory,
      () => new Date("2026-09-21T01:00:00.000Z")
    );

    await provider.getSignals();
    current = { clickCount: 120, conversions: 4 };
    const signal = (await provider.getSignals()).get("p1");
    assert.ok(signal);
    assert.equal(signal.trendAdjustment, 2);
    assert.equal(signal.adjustment, 7.33);
    assert.ok(await memory.latestByProduct("p1"));
  });
});
