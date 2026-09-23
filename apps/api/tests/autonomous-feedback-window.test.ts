import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

test("time-windowed learning exposes recent seven-day performance", async () => {
  const overview = {
    clickCount: 60, trackingLinkCount: 1, campaignCount: 1, contentCount: 1,
    publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 6,
    attributedRevenueCents: 6000, attributedCommissionCents: 600, conversionRate: 0.1,
    campaigns: [{
      campaignId: "c1", productId: "p1", marketplaceId: "m1", category: "electronics",
      audienceSegments: ["electronics"], clickCount: 60, trackingLinkCount: 1, contentCount: 1,
      publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 6,
      attributedRevenueCents: 6000, attributedCommissionCents: 600, conversionRate: 0.1
    }]
  };
  const memory = {
    latestByProductAndMarketplace: async () => undefined,
    latestByProduct: async () => undefined,
    recentByProductAndMarketplace: async () => [{
      id: "old", observationKey: "old", productId: "p1", marketplaceId: "m1",
      clickCount: 40, conversionCount: 2, attributedCommissionCents: 200,
      commissionPerClickCents: 5, conversionRate: 0.05, adjustment: 0,
      observedAt: "2026-09-18T00:00:00.000Z"
    }],
    saveIfAbsent: async (snapshot: any) => snapshot
  };
  const provider = new AutonomousAnalyticsFeedbackProvider(
    { overview: async () => overview },
    memory as any,
    () => new Date("2026-09-23T00:00:00.000Z")
  );
  const signal = (await provider.getSignals()).get("m1:p1");
  assert.equal(signal?.recentClickCount, 20);
  assert.equal(signal?.recentConversionCount, 4);
  assert.equal(signal?.recentConversionRate, 0.2);
  assert.equal(signal?.recentWindowDays, 7);
});
