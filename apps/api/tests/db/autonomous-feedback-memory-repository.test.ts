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
