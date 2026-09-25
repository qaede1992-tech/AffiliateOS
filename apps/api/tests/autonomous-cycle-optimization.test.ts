import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousCycleService } from "../src/domain/autonomous-cycle.js";
import { AutonomousOptimizationRunner } from "../src/domain/autonomous-optimization-runner.js";
import { InMemoryOptimizationStateStore } from "../src/domain/autonomous-optimization.js";
import type { AutonomousCampaignActionResult } from "../src/domain/autonomous-campaign-action-executor.js";
import type { CampaignAnalytics } from "../src/domain/analytics.js";

const analyticsCampaign: CampaignAnalytics = {
  campaignId: "00000000-0000-0000-0000-000000000001",
  productId: "00000000-0000-0000-0000-000000000002",
  marketplaceId: "00000000-0000-0000-0000-000000000003",
  clickCount: 20,
  trackingLinkCount: 1,
  contentCount: 1,
  publishedContentCount: 1,
  scheduledContentCount: 0,
  attributedConversionCount: 1,
  attributedRevenueCents: 1000,
  attributedCommissionCents: 100,
  conversionRate: 0.05
};

const actionResult: AutonomousCampaignActionResult = {
  campaignId: analyticsCampaign.campaignId,
  action: "scale",
  campaign: {} as never,
  mutated: false
};

test("autonomous cycle runs optimization after execution", async () => {
  let optimizationCalls = 0;
  const state = new InMemoryOptimizationStateStore();
  const optimization = new AutonomousOptimizationRunner(
    { async overview() { optimizationCalls += 1; return { clickCount: 20, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 1, attributedRevenueCents: 1000, attributedCommissionCents: 100, conversionRate: 0.05, campaigns: [analyticsCampaign] }; } },
    state,
    state,
    { async execute() { return actionResult; } } as never
  );
  const cycle = new AutonomousCycleService(
    { async listCandidates() { return []; } },
    { async runOnce() { return { selected: [], rejected: [], outcomes: [], recoveredRunCount: 0 }; } } as never,
    undefined,
    "test:autonomous-cycle",
    optimization
  );

  const result = await cycle.runOnce();

  assert.ok(result);
  assert.equal(optimizationCalls, 1);
  assert.equal(result.optimization?.recommendations[0]?.action, "scale");
  assert.equal(result.optimization?.actions[0]?.mutated, false);
});

test("optimization state cooldown survives repeated cycle evaluation", async () => {
  const state = new InMemoryOptimizationStateStore();
  let executions = 0;
  const optimization = new AutonomousOptimizationRunner(
    { async overview() { return { clickCount: 100, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 0, attributedRevenueCents: 0, attributedCommissionCents: 0, conversionRate: 0, campaigns: [{ ...analyticsCampaign, clickCount: 100, attributedConversionCount: 0, conversionRate: 0 }] }; } },
    state,
    state,
    { async execute() { executions += 1; return { ...actionResult, action: "pause", mutated: true }; } } as never,
    { pauseAfterClicks: 100, pauseConversionRate: 0.01, cooldownMs: 60 * 60_000 }
  );

  const now = new Date("2026-09-22T01:00:00.000Z");
  await optimization.run(now);
  const second = await optimization.run(new Date(now.getTime() + 1_000));

  assert.equal(executions, 1);
  assert.equal(second.recommendations[0]?.action, "maintain");
});


test("optimization runner blocks actions during anomaly halt", async () => {
  let executions = 0;
  const state = new InMemoryOptimizationStateStore();
  const optimization = new AutonomousOptimizationRunner(
    { async overview() { return { clickCount: 20, trackingLinkCount: 1, campaignCount: 1, contentCount: 1, publishedContentCount: 1, scheduledContentCount: 0, attributedConversionCount: 1, attributedRevenueCents: 1000, attributedCommissionCents: 100, conversionRate: 0.05, campaigns: [analyticsCampaign] }; } },
    state,
    state,
    { async execute() { executions += 1; return actionResult; } } as never,
    undefined,
    undefined,
    undefined,
    { async getSignals() { return new Map([["00000000-0000-0000-0000-000000000003:00000000-0000-0000-0000-000000000002", { anomaly: "halt" }]]); } } as never
  );

  const result = await optimization.run();

  assert.equal(executions, 0);
  assert.equal(result.recommendations[0]?.action, "maintain");
  assert.match(result.recommendations[0]?.reasons[0] ?? "", /anomaly halt/);
});
