import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";

const overview = {
  campaigns: [{
    campaignId: "campaign",
    productId: "product",
    marketplaceId: "marketplace",
    clickCount: 40,
    trackingLinkCount: 1,
    contentCount: 1,
    publishedContentCount: 1,
    scheduledContentCount: 0,
    attributedConversionCount: 2,
    attributedRevenueCents: 1000,
    attributedCommissionCents: 200,
    conversionRate: 0.05
  }]
};

function createProvider() {
  let now = new Date("2026-11-11T00:00:00.000Z");
  let overviewReads = 0;
  let historyReads = 0;
  let writes = 0;
  const memory = {
    async latestByProductAndMarketplace() { return undefined; },
    async recentByProductAndMarketplace() { historyReads += 1; return []; },
    async saveIfAbsent(snapshot: unknown) { writes += 1; return snapshot; }
  };
  const provider = new AutonomousAnalyticsFeedbackProvider({
    async overview() { overviewReads += 1; return overview; }
  }, memory, () => now);
  return {
    provider,
    counts: () => ({ overviewReads, historyReads, writes }),
    advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); }
  };
}

test("reuses one feedback snapshot across repeated selection passes in the same autonomous cycle", async () => {
  const harness = createProvider();
  const key = "autonomous-cycle:2026-11-11T00:00";
  const first = await harness.provider.getSignals({ observationKey: key });
  const second = await harness.provider.getSignals({ observationKey: key });
  const third = await harness.provider.getSignals({ observationKey: key });

  assert.equal(first.get("marketplace:product")?.clickCount, 40);
  assert.equal(second.get("marketplace:product")?.clickCount, 40);
  assert.equal(third.get("marketplace:product")?.clickCount, 40);
  assert.deepEqual(harness.counts(), { overviewReads: 1, historyReads: 1, writes: 1 });
});

test("does not reuse preview observations and expires cycle cache entries", async () => {
  const harness = createProvider();
  await harness.provider.getSignals({ observationKey: "autonomous-preview" });
  await harness.provider.getSignals({ observationKey: "autonomous-preview" });
  assert.deepEqual(harness.counts(), { overviewReads: 2, historyReads: 2, writes: 2 });

  await harness.provider.getSignals({ observationKey: "autonomous-cycle:bucket" });
  await harness.provider.getSignals({ observationKey: "autonomous-cycle:bucket" });
  assert.deepEqual(harness.counts(), { overviewReads: 3, historyReads: 3, writes: 3 });

  harness.advance(20 * 60_000 + 1);
  await harness.provider.getSignals({ observationKey: "autonomous-cycle:bucket" });
  assert.deepEqual(harness.counts(), { overviewReads: 4, historyReads: 4, writes: 4 });
});
