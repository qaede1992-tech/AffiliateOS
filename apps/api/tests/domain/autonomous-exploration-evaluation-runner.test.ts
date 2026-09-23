import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousExplorationEvaluationRunner } from "../../src/domain/autonomous-exploration-evaluation-runner.js";
import type { AutonomousDecisionAudit, AutonomousDecisionAuditRepository, AutonomousDecisionAuditReader } from "../../src/domain/autonomous-decision-audit.js";

const audit: AutonomousDecisionAudit = {
  auditId: "a1", cycleId: "c1", productId: "p1", marketplaceId: "m1", selected: true, score: 70,
  policy: {}, reasons: ["Selected for controlled exploration"], selectionMode: "exploration",
  createdAt: "2026-09-23T00:00:00.000Z",
  outcome: { status: "completed", observedAt: "2026-09-23T01:00:00.000Z", analytics: {
    clickCount: 100, attributedConversionCount: 4, attributedRevenueCents: 1000,
    attributedCommissionCents: 100, conversionRate: 0.04
  }}
};

describe("autonomous exploration evaluation runner", () => {
  it("evaluates persisted exploration outcomes and skips already evaluated audits", async () => {
    const stored: Record<string, unknown>[] = [];
    const reader: AutonomousDecisionAuditReader = { list: async () => [audit] };
    const repository: AutonomousDecisionAuditRepository = {
      saveMany: async () => {},
      updateOutcome: async () => {},
      updateExplorationEvaluation: async (auditId, evaluation) => { stored.push({ auditId, evaluation }); }
    };
    const runner = new AutonomousExplorationEvaluationRunner(reader, repository);
    const result = await runner.run();
    assert.equal(result.evaluated, 1);
    assert.equal(stored[0]?.auditId, "a1");

    const alreadyEvaluated = { ...audit, outcome: { ...audit.outcome!, explorationEvaluation: stored[0]?.evaluation as any } };
    const second = new AutonomousExplorationEvaluationRunner({ list: async () => [alreadyEvaluated] }, repository);
    const secondResult = await second.run();
    assert.equal(secondResult.skipped, 1);
  });
});
