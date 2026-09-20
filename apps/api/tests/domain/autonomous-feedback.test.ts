import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSignals } from "../../src/domain/autonomous-feedback.js";

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
});
