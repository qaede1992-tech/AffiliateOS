import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

test("persists only product performance signals in feedback memory", async () => {
  const calls: string[] = [];
  const saved: string[] = [];
  const overview = {
    campaigns: [{
      campaignId: "c1", productId: "product-1", marketplaceId: "marketplace-1", category: "electronics", audienceSegments: ["electronics"],
      clickCount: 40, trackingLinkCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0,
      attributedConversionCount: 4, attributedRevenueCents: 4000, attributedCommissionCents: 400, conversionRate: 0.1
    }]
  };
  const memory = {
    latestByProductAndMarketplace: async (productId: string, marketplaceId: string) => {
      calls.push(productId + ":" + marketplaceId);
      return undefined;
    },
    latestByProduct: async (productId: string) => {
      calls.push(productId);
      return undefined;
    },
    saveIfAbsent: async (snapshot: { observationKey: string }) => {
      saved.push(snapshot.observationKey);
      return snapshot;
    }
  };

  const provider = new AutonomousAnalyticsFeedbackProvider(
    { overview: async () => overview },
    memory,
    () => new Date("2026-10-06T00:00:00.000Z")
  );

  const signals = await provider.getSignals({ observationKey: "aggregate-regression" });

  assert.ok(signals.has("marketplace-1:product-1"));
  assert.ok(signals.has("marketplace-1:category:electronics"));
  assert.ok(signals.has("global:category:electronics"));
  assert.ok(signals.has("marketplace-1:audience:electronics"));
  assert.ok(signals.has("global:audience:electronics"));
  assert.deepEqual(calls, ["product-1:marketplace-1"]);
  assert.deepEqual(saved, ["aggregate-regression:marketplace-1:product-1"]);
});


test("does not persist product feedback when marketplace scope is missing", async () => {
  const saved: unknown[] = [];
  const memory = {
    latestByProductAndMarketplace: async () => undefined,
    latestByProduct: async () => undefined,
    saveIfAbsent: async (snapshot: unknown) => { saved.push(snapshot); return snapshot; }
  };
  const overview = {
    campaigns: [{
      campaignId: "c2", productId: "product-2",
      clickCount: 10, trackingLinkCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0,
      attributedConversionCount: 1, attributedRevenueCents: 1000, attributedCommissionCents: 100, conversionRate: 0.1
    }]
  };
  const provider = new AutonomousAnalyticsFeedbackProvider(
    { overview: async () => overview },
    memory,
    () => new Date("2026-10-06T00:00:00.000Z")
  );
  const signals = await provider.getSignals({ observationKey: "missing-marketplace" });
  assert.ok(signals.has("product-2"));
  assert.equal(saved.length, 0);
});
