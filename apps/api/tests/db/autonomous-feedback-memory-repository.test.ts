import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { DrizzleAutonomousFeedbackMemoryRepository } from "../../src/db/autonomous-feedback-memory-repository.js";

const productId = "00000000-0000-4000-8000-000000000001";
const marketplaceId = "00000000-0000-4000-8000-000000000002";

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    observationKey: "observation",
    productId,
    marketplaceId,
    clickCount: 25,
    conversionCount: 2,
    attributedCommissionCents: 500,
    commissionPerClickCents: 20,
    conversionRate: 0.08,
    adjustment: 1,
    anomaly: "none",
    anomalyScore: 0,
    recoveryState: "none",
    recoveryClicks: 0,
    recoveryEvidenceScore: 0,
    recoveryQualityScore: 0,
    recoveryPolicy: null,
    recoveryEpisodeId: null,
    observedAt: "2026-11-09T00:00:00.000Z",
    ...overrides
  };
}

test("feedback history query loads bounded window and recovery anchors instead of full history", async () => {
  let statement: unknown;
  const db = {
    async execute(query: unknown) {
      statement = query;
      return { rows: [snapshotRow()] };
    }
  };
  const repository = new DrizzleAutonomousFeedbackMemoryRepository(db);
  const rows = await repository.recentByProductAndMarketplace(
    productId,
    marketplaceId,
    "2026-10-12T00:00:00.000Z"
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.productId, productId);
  assert.equal(rows[0]?.marketplaceId, marketplaceId);
  assert.equal(rows[0]?.clickCount, 25);

  const query = new PgDialect().sqlToQuery(statement as never);
  assert.match(query.sql, /WITH latest AS MATERIALIZED/);
  assert.match(query.sql, /halt_anchor AS MATERIALIZED/);
  assert.match(query.sql, /CROSS JOIN LATERAL/);
  assert.match(query.sql, /LIMIT 3/);
  assert.ok(query.params.includes("2026-11-10T00:00:00.000Z"));
  assert.ok(query.params.includes("2026-11-04T00:00:00.000Z"));
  assert.ok(query.params.includes("2026-10-12T00:00:00.000Z"));
  assert.equal(query.params.filter((value) => value === productId).length, 5);
});

test("feedback history rejects an invalid cutoff rather than issuing an unbounded query", async () => {
  let executed = false;
  const repository = new DrizzleAutonomousFeedbackMemoryRepository({
    async execute() { executed = true; return { rows: [] }; }
  });

  await assert.rejects(
    repository.recentByProductAndMarketplace(productId, marketplaceId, "not-a-date"),
    /valid timestamp/
  );
  assert.equal(executed, false);
});

test("recovery episode analytics aggregates episode rows without loading the snapshot history", async () => {
  let statement: unknown;
  const db = {
    async execute(query: unknown) {
      statement = query;
      return { rows: [{
        snapshot_count: 4,
        started_at: "2026-11-01T00:00:00.000Z",
        ended_at: "2026-11-02T00:00:00.000Z",
        average_quality_score: 0.75,
        start_conversion_count: 2,
        start_commission_cents: 100,
        recovered_clicks: 30,
        recovered_conversion_count: 4,
        recovered_commission_cents: 300,
        closing_quality_score: 0.9,
        latest_clicks: 30,
        latest_conversion_count: 4,
        latest_commission_cents: 300
      }] };
    }
  };
  const repository = new DrizzleAutonomousFeedbackMemoryRepository(db);
  const analytics = await repository.recoveryEpisodeAnalytics(productId, marketplaceId, "00000000-0000-4000-8000-000000000004");

  assert.equal(analytics?.snapshotCount, 4);
  assert.equal(analytics?.closed, true);
  assert.equal(analytics?.recoveryClicks, 30);
  assert.equal(analytics?.conversionDelta, 2);
  assert.equal(analytics?.commissionDeltaCents, 200);
  assert.equal(analytics?.averageQualityScore, 0.75);
  assert.equal(analytics?.closingQualityScore, 0.9);

  const query = new PgDialect().sqlToQuery(statement as never);
  assert.match(query.sql, /COUNT\(\*\)/);
  assert.match(query.sql, /ARRAY_AGG/);
  assert.match(query.sql, /recovery_episode_id/);
});
