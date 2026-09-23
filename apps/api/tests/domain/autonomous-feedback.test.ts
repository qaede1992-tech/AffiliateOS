const campaign = (productId: string, clicks: number, conversions: number, commission = 0, marketplaceId?: string) => ({
  campaignId: productId + "-campaign", productId, marketplaceId, clickCount: clicks, trackingLinkCount: 1, contentCount: 1,
  publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: conversions,
  attributedRevenueCents: conversions * 10000, attributedCommissionCents: commission, conversionRate: clicks ? conversions / clicks : 0
});

describe("Autonomous analytics feedback", () => {
  it("keeps feedback isolated by marketplace for the same product id", async () => {
    const overview = {
      clickCount: 200, trackingLinkCount: 2, campaignCount: 2, contentCount: 2,
      publishedContentCount: 2, scheduledContentCount: 0, attributedConversionCount: 12,
      attributedRevenueCents: 120000, attributedCommissionCents: 12000, conversionRate: 0.06,
      campaigns: [campaign("p1", 100, 10, 10000, "market-1"), campaign("p1", 100, 2, 2000, "market-2")]
    };
    const signals = buildSignals(overview);
    assert.equal(signals.get("market-1:p1")?.adjustment, 8);
    assert.equal(signals.get("market-2:p1")?.adjustment, 0);
    assert.equal(signals.get("p1"), undefined);
    const memory = new InMemoryAutonomousFeedbackMemoryRepository();
    const provider = new AutonomousAnalyticsFeedbackProvider({ overview: async () => overview }, memory, () => new Date("2026-09-21T02:00:00.000Z"));
    await provider.getSignals({ observationKey: "cycle-1" });
    assert.equal((await memory.latestByProductAndMarketplace("p1", "market-1"))?.adjustment, 8);
    assert.equal((await memory.latestByProductAndMarketplace("p1", "market-2"))?.adjustment, 0);
  });

  it("does not adjust products without enough click evidence", () => {
    const signals = buildSignals({ clickCount: 10, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 1, attributedRevenueCents: 10000, attributedCommissionCents: 500, conversionRate: 0.1, campaigns: [campaign("p1", 10, 1, 500)] });
    assert.equal(signals.get("p1")?.adjustment, 0);
  });

  it("boosts products with materially strong conversion performance", () => {
    const signals = buildSignals({ clickCount: 100, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 10, attributedRevenueCents: 100000, attributedCommissionCents: 5000, conversionRate: 0.1, campaigns: [campaign("p1", 100, 10, 5000)] });
    assert.equal(signals.get("p1")?.adjustment, 8);
    assert.equal(signals.get("p1")?.conversionCount, 10);
  });

  it("penalizes products with weak conversion performance", () => {
    const signals = buildSignals({ clickCount: 100, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 0, attributedRevenueCents: 0, attributedCommissionCents: 0, conversionRate: 0, campaigns: [campaign("p1", 100, 0)] });
    assert.equal(signals.get("p1")?.adjustment, -8);
  });

  it("persists snapshots and applies a bounded incremental trend adjustment", async () => {
    const memory = new InMemoryAutonomousFeedbackMemoryRepository();
    let current = { clickCount: 100, conversions: 2 };
    const provider = new AutonomousAnalyticsFeedbackProvider(
      { overview: async () => ({ ...current, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: current.conversions, attributedRevenueCents: 100000, attributedCommissionCents: 10000, conversionRate: current.conversions / current.clickCount, campaigns: [campaign("p1", current.clickCount, current.conversions, 10000)] }) },
      memory, () => new Date("2026-09-21T01:00:00.000Z")
    );
    await provider.getSignals();
    current = { clickCount: 120, conversions: 4 };
    const signal = (await provider.getSignals()).get("p1");
    assert.ok(signal);
    assert.equal(signal.conversionCount, 4);
    assert.equal(signal.trendAdjustment, 2);
    assert.equal(signal.adjustment, 7.33);
    assert.equal((await memory.latestByProduct("p1"))?.commissionPerClickCents, 83.33333333333333);
  });

  it("tracks commission efficiency and keeps its contribution bounded", async () => {
    const memory = new InMemoryAutonomousFeedbackMemoryRepository();
    let commission = 1000;
    const provider = new AutonomousAnalyticsFeedbackProvider(
      { overview: async () => ({ clickCount: 100, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 2, attributedRevenueCents: 100000, attributedCommissionCents: commission, conversionRate: 0.02, campaigns: [campaign("p1", 100, 2, commission, "market-1")] }) },
      memory, () => new Date("2026-09-21T03:00:00.000Z")
    );
    const first = (await provider.getSignals({ observationKey: "efficiency-1" })).get("market-1:p1");
    assert.equal(first?.commissionPerClickCents, 10);
    commission = 2000;
    const second = (await provider.getSignals({ observationKey: "efficiency-2" })).get("market-1:p1");
    assert.equal(second?.commissionPerClickCents, 20);
    assert.ok((second?.adjustment ?? 0) <= 8);
  });
  it("aggregates cross-campaign category performance within a marketplace", async () => {
    const analytics = {
      async overview() {
        return {
          clickCount: 200, trackingLinkCount: 2, campaignCount: 2, contentCount: 2,
          publishedContentCount: 2, scheduledContentCount: 0, attributedConversionCount: 10,
          attributedRevenueCents: 20000, attributedCommissionCents: 1000, conversionRate: 0.05,
          campaigns: [
            { campaignId: "c1", productId: "p1", marketplaceId: "m1", category: "skincare", clickCount: 100, trackingLinkCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 6, attributedRevenueCents: 12000, attributedCommissionCents: 600, conversionRate: 0.06 },
            { campaignId: "c2", productId: "p2", marketplaceId: "m1", category: "skincare", clickCount: 100, trackingLinkCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 4, attributedRevenueCents: 8000, attributedCommissionCents: 400, conversionRate: 0.04 }
          ]
        };
      }
    };
    const signals = await new AutonomousAnalyticsFeedbackProvider(analytics).getSignals();
    const signal = signals.get("m1:category:skincare");
    assert.equal(signal?.clickCount, 200);
    assert.equal(signal?.conversionCount, 10);
    assert.equal(signal?.conversionRate, 0.05);
    assert.equal(signal?.attributedCommissionCents, 1000);
  });

});
