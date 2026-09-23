import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateExploration } from "../../src/domain/exploration-evaluator.js";
import type { AutonomousDecisionAudit } from "../../src/domain/autonomous-decision-audit.js";

const audit = (analytics: { clickCount:number; attributedConversionCount:number; attributedRevenueCents:number; attributedCommissionCents:number; conversionRate:number }): AutonomousDecisionAudit => ({
  auditId: "audit-1", cycleId: "cycle-1", productId: "product-1", marketplaceId: "market-1", selected: true,
  score: 72, policy: { explorationRate: 0.2 }, reasons: ["Selected for controlled exploration"], selectionMode: "exploration",
  createdAt: "2026-09-23T00:00:00.000Z", outcome: { status: "completed", observedAt: "2026-09-23T00:00:00.000Z", analytics }
});

describe("exploration evaluator", () => {
  it("waits for sufficient evidence", () => {
    const result = evaluateExploration(audit({ clickCount: 10, attributedConversionCount: 1, attributedRevenueCents: 100, attributedCommissionCents: 10, conversionRate: 0.1 }));
    assert.equal(result?.status, "insufficient-evidence");
  });
  it("promotes strong exploration results", () => {
    const result = evaluateExploration(audit({ clickCount: 100, attributedConversionCount: 4, attributedRevenueCents: 1000, attributedCommissionCents: 100, conversionRate: 0.04 }));
    assert.equal(result?.status, "promote-to-exploitation");
  });
  it("deprioritizes weak exploration results", () => {
    const result = evaluateExploration(audit({ clickCount: 100, attributedConversionCount: 0, attributedRevenueCents: 0, attributedCommissionCents: 0, conversionRate: 0 }));
    assert.equal(result?.status, "deprioritize");
  });
  it("keeps mixed results in exploration", () => {
    const result = evaluateExploration(audit({ clickCount: 100, attributedConversionCount: 2, attributedRevenueCents: 500, attributedCommissionCents: 20, conversionRate: 0.02 }));
    assert.equal(result?.status, "continue-exploration");
  });
  it("ignores non-exploration decisions", () => {
    const base = audit({ clickCount: 100, attributedConversionCount: 4, attributedRevenueCents: 1000, attributedCommissionCents: 100, conversionRate: 0.04 });
    assert.equal(evaluateExploration({ ...base, selectionMode: "exploitation" }), undefined);
  });
});


test("recovery-phase exploration evidence is isolated from learning",()=>{
 const audit:any={selectionMode:"exploration",recovery:{anomaly:"none",recoveryState:"recovering",recoveryClicks:25,recoveryEvidenceScore:.4},outcome:{analytics:{clickCount:100,attributedConversionCount:10,attributedRevenueCents:1000,attributedCommissionCents:100,conversionRate:.1}}};
 const result=evaluateExploration(audit);
 assert.equal(result?.status,"continue-exploration");
 assert.equal(result?.confidence,.25);
 assert.match(result?.reason??"","isolated");
});
