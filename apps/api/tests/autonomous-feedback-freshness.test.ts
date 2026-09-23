import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

const overview = {
  clickCount: 40, trackingLinkCount: 1, campaignCount: 1, contentCount: 1,
  publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 4,
  attributedRevenueCents: 4000, attributedCommissionCents: 400, conversionRate: 0.1,
  campaigns: [{
    campaignId: "c1", productId: "p1", marketplaceId: "m1", category: "electronics",
    audienceSegments: ["electronics"], clickCount: 40, trackingLinkCount: 1, contentCount: 1,
    publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 4,
    attributedRevenueCents: 4000, attributedCommissionCents: 400, conversionRate: 0.1
  }]
};

test("learning freshness decays stale trend and efficiency feedback", async () => {
  const memory = {
    latestByProductAndMarketplace: async () => ({
      id: "old", observationKey: "old", productId: "p1", marketplaceId: "m1",
      clickCount: 20, conversionCount: 0, attributedCommissionCents: 0,
      commissionPerClickCents: 0, conversionRate: 0, adjustment: -8,
      observedAt: "2026-09-09T00:00:00.000Z"
    }),
    latestByProduct: async () => undefined,
    save: async (snapshot: any) => snapshot,
    saveIfAbsent: async (snapshot: any) => snapshot
  };
  const provider = new AutonomousAnalyticsFeedbackProvider(
    { overview: async () => overview },
    memory as any,
    () => new Date("2026-09-23T00:00:00.000Z")
  );
  const signal = (await provider.getSignals()).get("m1:p1");
  assert.ok(signal);
  assert.ok(Math.abs(signal!.trendAdjustment) < 2);
  assert.equal(signal!.adjustment, 8);
});
