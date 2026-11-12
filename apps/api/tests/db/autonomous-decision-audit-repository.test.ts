import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { DrizzleAutonomousDecisionAuditRepository } from "../../src/db/autonomous-decision-audit-repository.js";

test("unfiltered decision audit history uses bounded selected-index branches", async () => {
  let statement: unknown;
  let selectCalls = 0;
  const auditId = "00000000-0000-4000-8000-000000000001";
  const db = {
    async execute(query: unknown) {
      statement = query;
      return {
        rows: [{
          id: auditId,
          cycleId: "cycle-1",
          productId: "00000000-0000-4000-8000-000000000002",
          marketplaceId: "00000000-0000-4000-8000-000000000003",
          selected: false,
          selectionMode: null,
          score: 42,
          policy: {},
          reasons: ["test"],
          category: null,
          audienceSegments: null,
          outcomeOfferId: null,
          outcomeStatus: null,
          outcomeCampaignId: null,
          outcomeError: null,
          outcomeObservedAt: null,
          recovery: null,
          explorationEvaluation: null,
          createdAt: "2026-11-12T04:00:00.000Z"
        }]
      };
    },
    select() {
      selectCalls += 1;
      throw new Error("Unfiltered audit history must use the bounded indexed query.");
    }
  };

  const repository = new DrizzleAutonomousDecisionAuditRepository(db);
  const audits = await repository.list({ limit: 100 });

  assert.equal(selectCalls, 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.auditId, auditId);
  assert.equal(audits[0]?.selected, false);

  const query = new PgDialect().sqlToQuery(statement as never);
  assert.match(query.sql, /UNION ALL/);
  assert.match(query.sql, /WHERE selected = true/);
  assert.match(query.sql, /WHERE selected = false/);
  assert.equal(query.params.length, 3);
  assert.deepEqual(query.params, [100, 100, 100]);
});
