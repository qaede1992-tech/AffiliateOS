import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAnalyticsFeedbackProvider } from "../src/domain/autonomous-feedback.js";
import { InMemoryAutonomousFeedbackMemoryRepository, type AutonomousFeedbackSnapshot } from "../src/domain/autonomous-feedback-memory.js";

test("loads product snapshot history once for windows and recovery analysis", async () => {
  const halt = {
    id: "halt-1", observationKey: "halt-1", productId: "p", marketplaceId: "m",
    clickCount: 200, conversionCount: 4, attributedCommissionCents: 400,
    commissionPerClickCents: 2, conversionRate: 0.02, adjustment: 0,
    anomaly: "halt" as const, anomalyScore: 0.8, recoveryState: "recovering" as const,
    recoveryClicks: 0, recoveryEvidenceScore: 0, recoveryQualityScore: 0,
    observedAt: "2026-09-22T00:00:00.000Z"
  };
  const snapshots = [
    { ...halt, id: "baseline", anomaly: "none" as const, recoveryState: "none" as const, recoveryEpisodeId: undefined, observedAt: "2026-08-25T00:00:00.000Z", clickCount: 100, conversionCount: 2 },
    halt,
    ...[
      ["recovery-1", "2026-09-22T01:00:00.000Z", 210, 4],
      ["recovery-2", "2026-09-22T02:00:00.000Z", 225, 4],
      ["recovery-3", "2026-09-22T03:00:00.000Z", 240, 5]
    ].map(([id, observedAt, clickCount, conversionCount]) => ({
      ...halt, id: String(id), observationKey: String(id), observedAt: String(observedAt),
      clickCount: Number(clickCount), conversionCount: Number(conversionCount),
      anomaly: "none" as const, recoveryState: "recovering" as const,
      recoveryEpisodeId: halt.id, recoveryClicks: Number(clickCount) - halt.clickCount,
      recoveryEvidenceScore: 1, recoveryQualityScore: 0.8
    }))
  ];
  let historyReads = 0;
  let latestReads = 0;
  const memory = {
    latestByProductAndMarketplace: async () => { latestReads += 1; return halt; },
    relevantByProductAndMarketplace: async () => { historyReads += 1; return snapshots; },
    saveIfAbsent: async (snapshot: unknown) => snapshot
  };
  const provider = new AutonomousAnalyticsFeedbackProvider(
    { overview: async () => ({ campaigns: [{
      campaignId: "c", productId: "p", marketplaceId: "m", clickCount: 250,
      trackingLinkCount: 1, contentCount: 1, publishedContentCount: 1,
      scheduledContentCount: 0, attributedConversionCount: 5,
      attributedRevenueCents: 2500, attributedCommissionCents: 500,
      conversionRate: 0.02
    }] }) },
    memory,
    () => new Date("2026-09-22T04:00:00.000Z")
  );

  const signal = (await provider.getSignals()).get("m:p");
  assert.equal(historyReads, 1);
  assert.equal(latestReads, 0);
  assert.ok(signal?.windows);
  assert.equal(signal?.recoveryEpisodeId, halt.id);
});

test("falls back to the latest snapshot when no snapshot exists in the 30-day window", async () => {
  const previous = {
    id: "old-halt", observationKey: "old-halt", productId: "p", marketplaceId: "m",
    clickCount: 200, conversionCount: 4, attributedCommissionCents: 400,
    commissionPerClickCents: 2, conversionRate: 0.02, adjustment: 0,
    anomaly: "halt" as const, anomalyScore: 0.8, recoveryState: "recovering" as const,
    recoveryClicks: 0, recoveryEvidenceScore: 0, recoveryQualityScore: 0,
    observedAt: "2026-09-22T03:00:00.000Z"
  };
  let historyReads = 0;
  let latestReads = 0;
  const memory = {
    latestByProductAndMarketplace: async () => { latestReads += 1; return previous; },
    relevantByProductAndMarketplace: async () => { historyReads += 1; return []; },
    saveIfAbsent: async (snapshot: unknown) => snapshot
  };
  const provider = new AutonomousAnalyticsFeedbackProvider(
    { overview: async () => ({ campaigns: [{
      campaignId: "c", productId: "p", marketplaceId: "m", clickCount: 250,
      trackingLinkCount: 1, contentCount: 1, publishedContentCount: 1,
      scheduledContentCount: 0, attributedConversionCount: 5,
      attributedRevenueCents: 2500, attributedCommissionCents: 500,
      conversionRate: 0.02
    }] }) },
    memory,
    () => new Date("2026-09-22T04:00:00.000Z")
  );

  const signal = (await provider.getSignals()).get("m:p");
  assert.equal(historyReads, 1);
  assert.equal(latestReads, 1);
  assert.equal(signal?.anomaly, "halt");
  assert.equal(signal?.recoveryEpisodeId, previous.id);
});


test("uses one latest snapshot without loading or persisting full history for discovery previews", async () => {
  const previous = {
    id: "halt-latest", observationKey: "halt-latest", productId: "p", marketplaceId: "m",
    clickCount: 200, conversionCount: 4, attributedCommissionCents: 400,
    commissionPerClickCents: 2, conversionRate: 0.02, adjustment: 0,
    anomaly: "halt" as const, anomalyScore: 0.8, recoveryState: "recovering" as const,
    recoveryClicks: 0, recoveryEvidenceScore: 0, recoveryQualityScore: 0,
    observedAt: "2026-09-22T03:00:00.000Z"
  };
  let historyReads = 0;
  let latestReads = 0;
  let snapshotWrites = 0;
  const memory = {
    latestByProductAndMarketplace: async () => { latestReads += 1; return previous; },
    recentByProductAndMarketplace: async () => { historyReads += 1; return [previous]; },
    saveIfAbsent: async (snapshot: AutonomousFeedbackSnapshot) => { snapshotWrites += 1; return snapshot; }
  };
  const provider = new AutonomousAnalyticsFeedbackProvider(
    { overview: async () => ({ campaigns: [{
      campaignId: "c", productId: "p", marketplaceId: "m", clickCount: 250,
      trackingLinkCount: 1, contentCount: 1, publishedContentCount: 1,
      scheduledContentCount: 0, attributedConversionCount: 5,
      attributedRevenueCents: 2500, attributedCommissionCents: 500,
      conversionRate: 0.02
    }] }) },
    memory,
    () => new Date("2026-09-22T04:00:00.000Z")
  );

  const signal = (await provider.getSignals({ observationKey: "discovery-preview", historyMode: "latest" })).get("m:p");
  assert.equal(historyReads, 0);
  assert.equal(latestReads, 1);
  assert.equal(snapshotWrites, 0);
  assert.equal(signal?.windows, undefined);
  assert.equal(signal?.anomaly, "halt");
  assert.equal(signal?.recoveryEpisodeId, previous.id);
});


test("in-memory relevant feedback history mirrors the bounded SQL selection", async () => {
  const memory = new InMemoryAutonomousFeedbackMemoryRepository();
  const observedAt = new Date("2026-10-30T12:00:00.000Z");
  const snapshot = (id: string, daysAgo: number, overrides: Partial<AutonomousFeedbackSnapshot> = {}): AutonomousFeedbackSnapshot => ({
    id,
    observationKey: id,
    productId: "product-1",
    marketplaceId: "marketplace-1",
    clickCount: 100 + daysAgo,
    conversionCount: 2,
    attributedCommissionCents: 200,
    commissionPerClickCents: 2,
    conversionRate: 0.02,
    adjustment: 0,
    anomaly: "none",
    anomalyScore: 0,
    recoveryState: "none",
    recoveryClicks: 0,
    recoveryEvidenceScore: 0,
    recoveryQualityScore: 0,
    observedAt: new Date(observedAt.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides
  });

  const rows: AutonomousFeedbackSnapshot[] = [];
  for (let day = 30; day >= 0; day -= 1) {
    const id = `day-${day}`;
    rows.push(snapshot(id, day, day === 6 ? { anomaly: "halt", recoveryState: "recovering" } : {}));
  }
  rows.push(snapshot("recovered-early", 5, {
    recoveryEpisodeId: "day-6",
    recoveryState: "recovered",
    anomaly: "none"
  }));
  rows.push(snapshot("recent-half-day", 0.5));
  for (const row of rows) await memory.save(row);

  const selected = await memory.relevantByProductAndMarketplace(
    "product-1",
    "marketplace-1",
    new Date(observedAt.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    observedAt.toISOString()
  );
  const ids = selected.map((row) => row.id);

  assert.ok(selected.length < rows.length, "must not return the entire 30-day history");
  assert.ok(selected.length <= 9, "must stay within the SQL query's maximum selected-row bound");
  assert.ok(ids.includes("day-30"), "must retain the earliest 30-day anchor");
  assert.ok(ids.includes("day-6"), "must retain the latest halt");
  assert.ok(ids.includes("recovered-early"), "must retain recovery evidence even outside the latest three snapshots");
  assert.ok(ids.includes("recent-half-day"), "must retain the 24-hour anchor");
  assert.equal(new Set(ids).size, ids.length, "must deduplicate snapshots selected by multiple windows");
  assert.deepEqual(
    selected.map((row) => row.observedAt),
    [...selected].map((row) => row.observedAt).sort()
  );
});
