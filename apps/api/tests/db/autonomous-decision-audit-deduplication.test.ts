import assert from "node:assert/strict";
import test from "node:test";
import { DrizzleAutonomousDecisionAuditRepository } from "../../src/db/autonomous-decision-audit-repository.js";
import type { AutonomousDecisionAudit } from "../../src/domain/autonomous-decision-audit.js";

const productId = "00000000-0000-4000-8000-000000000001";
const marketplaceId = "00000000-0000-4000-8000-000000000002";

function audit(overrides: Partial<AutonomousDecisionAudit> = {}): AutonomousDecisionAudit {
  return {
    auditId: "00000000-0000-4000-8000-000000000003",
    cycleId: "cycle-new",
    productId,
    marketplaceId,
    selected: false,
    score: 42,
    policy: { minimumScore: 60, requirePublishableMedia: true },
    reasons: ["No validated media", "Data confidence: 50.0% of scoring evidence is available"],
    category: "Home",
    createdAt: "2026-11-11T00:00:00.000Z",
    recovery: { anomaly: "none", recoveryState: "none", recoveryClicks: 0, recoveryEvidenceScore: 0 },
    ...overrides
  };
}

function previousSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    auditId: "00000000-0000-4000-8000-000000000004",
    productId,
    marketplaceId,
    selected: false,
    selectionMode: null,
    score: 42,
    policy: { requirePublishableMedia: true, minimumScore: 60 },
    reasons: ["No validated media", "Data confidence: 50.0% of scoring evidence is available"],
    category: "Home",
    audienceSegments: null,
    recovery: { recoveryClicks: 0, anomaly: "none", recoveryState: "none", recoveryEvidenceScore: 0 },
    ...overrides
  };
}

function fakeDatabase(previous: Record<string, unknown>[]) {
  let inserted: Record<string, unknown>[] | undefined;
  return {
    database: {
      async execute() { return previous; },
      insert() {
        return {
          async values(values: Record<string, unknown>[]) { inserted = values; }
        };
      }
    },
    inserted: () => inserted
  };
}

test("unchanged rejected decision snapshots are not inserted again", async () => {
  const db = fakeDatabase([previousSnapshot()]);
  const repository = new DrizzleAutonomousDecisionAuditRepository(db.database);
  await repository.saveMany([audit()]);
  assert.equal(db.inserted(), undefined);
});

test("changed rejected decision snapshots are preserved as new audit history", async () => {
  const db = fakeDatabase([previousSnapshot()]);
  const repository = new DrizzleAutonomousDecisionAuditRepository(db.database);
  await repository.saveMany([audit({ score: 43 })]);
  assert.equal(db.inserted()?.length, 1);
  assert.equal(db.inserted()?.[0]?.score, 43);
});

test("selected decisions are always inserted so outcomes attach to a fresh audit ID", async () => {
  const db = fakeDatabase([previousSnapshot()]);
  const repository = new DrizzleAutonomousDecisionAuditRepository(db.database);
  await repository.saveMany([audit({ selected: true, selectionMode: "exploitation" })]);
  assert.equal(db.inserted()?.length, 1);
  assert.equal(db.inserted()?.[0]?.selected, true);
});
