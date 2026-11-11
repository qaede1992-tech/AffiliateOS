import assert from "node:assert/strict";
import test from "node:test";
import { DrizzleAutonomousFeedbackMemoryRepository } from "../../src/db/autonomous-feedback-memory-repository.js";

test("feedback evaluation history reads only window anchors and a bounded recovery tail", async () => {
  const since = "2026-10-12T00:00:00.000Z";
  let compiled: { sql: string; params: unknown[] } | undefined;
  const db = {
    execute: async (query: { toQuery: (config: { escapeName: (name: string) => string; escapeParam: (index: number) => string; escapeString: (value: string) => string }) => { sql: string; params: unknown[] } }) => {
      compiled = query.toQuery({
        escapeName: (name) => `"${name}"`,
        escapeParam: (index) => `$${index + 1}`,
        escapeString: (value) => `'${value.replace(/'/g, "''")}'`
      });
      return { rows: [{
        id: "snapshot-1",
        observationKey: "observation-1",
        productId: "product-1",
        marketplaceId: "marketplace-1",
        clickCount: 40,
        conversionCount: 2,
        attributedCommissionCents: 500,
        commissionPerClickCents: 12.5,
        conversionRate: 0.05,
        adjustment: 1,
        anomaly: "none",
        anomalyScore: 0,
        recoveryState: "none",
        recoveryClicks: 0,
        recoveryEvidenceScore: 0,
        recoveryQualityScore: 0,
        recoveryPolicy: null,
        recoveryEpisodeId: null,
        observedAt: "2026-11-01T00:00:00.000Z"
      }] };
    }
  };
  const repository = new DrizzleAutonomousFeedbackMemoryRepository(db);
  const rows = await repository.feedbackEvaluationHistory("product-1", "marketplace-1", since);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.productId, "product-1");
  assert.equal(rows[0]?.observedAt, "2026-11-01T00:00:00.000Z");
  assert.ok(compiled);
  assert.match(compiled!.sql, /WITH history AS/);
  assert.match(compiled!.sql, /UNION ALL/);
  assert.match(compiled!.sql, /LIMIT 3/);
  assert.match(compiled!.sql, /recoveryEpisodeId/);
  assert.deepEqual(compiled!.params.slice(0, 5), [
    "product-1",
    "marketplace-1",
    since,
    "2026-11-04T00:00:00.000Z",
    "2026-11-10T00:00:00.000Z"
  ]);
});

test("feedback evaluation history rejects invalid cutoffs before querying", async () => {
  let queried = false;
  const repository = new DrizzleAutonomousFeedbackMemoryRepository({
    execute: async () => { queried = true; return { rows: [] }; }
  });
  await assert.rejects(
    repository.feedbackEvaluationHistory("product-1", "marketplace-1", "not-a-date"),
    /valid timestamp/
  );
  assert.equal(queried, false);
});
