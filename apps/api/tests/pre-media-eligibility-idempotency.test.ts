import assert from "node:assert/strict";
import test from "node:test";
import { DrizzlePreMediaEligibilityRepository } from "../src/db/pre-media-eligibility-repository.js";

test("pre-media evidence writes are idempotent for unchanged decisions", async () => {
  let inserted: Array<Record<string, unknown>> = [];
  let conflictHandlingEnabled = false;
  const db = {
    insert() {
      return {
        values(rows: Array<Record<string, unknown>>) {
          inserted = rows;
          return {
            onConflictDoNothing() {
              conflictHandlingEnabled = true;
              return Promise.resolve();
            }
          };
        }
      };
    }
  };
  const repository = new DrizzlePreMediaEligibilityRepository(db as never);
  const base = {
    id: "00000000-0000-4000-8000-000000000001",
    cycleId: "cycle-one",
    productId: "00000000-0000-4000-8000-000000000002",
    marketplaceId: "00000000-0000-4000-8000-000000000003",
    offerId: "00000000-0000-4000-8000-000000000004",
    eligible: true,
    score: 82,
    policy: { minimumScore: 60, mediaRequired: false },
    reasons: ["eligible", "commission_signal"],
    createdAt: "2026-11-09T00:00:00.000Z"
  };
  await repository.saveMany([base, {
    ...base,
    id: "00000000-0000-4000-8000-000000000005",
    cycleId: "cycle-two",
    createdAt: "2026-11-09T00:15:00.000Z",
    policy: { mediaRequired: false, minimumScore: 60 }
  }]);

  assert.equal(inserted.length, 2);
  assert.equal(inserted[0]?.fingerprint, inserted[1]?.fingerprint);
  assert.equal(conflictHandlingEnabled, true);
});

test("pre-media evidence fingerprint changes when eligibility decision changes", async () => {
  let inserted: Array<Record<string, unknown>> = [];
  const db = {
    insert() {
      return {
        values(rows: Array<Record<string, unknown>>) {
          inserted = rows;
          return { onConflictDoNothing: async () => undefined };
        }
      };
    }
  };
  const repository = new DrizzlePreMediaEligibilityRepository(db as never);
  const record = {
    id: "00000000-0000-4000-8000-000000000011",
    cycleId: "cycle-one",
    productId: "00000000-0000-4000-8000-000000000012",
    marketplaceId: "00000000-0000-4000-8000-000000000013",
    eligible: false,
    score: 42,
    policy: { minimumScore: 60 },
    reasons: ["score_below_minimum"],
    createdAt: "2026-11-09T00:00:00.000Z"
  };
  await repository.saveMany([record, { ...record, score: 61, eligible: true, reasons: ["eligible"] }]);
  assert.notEqual(inserted[0]?.fingerprint, inserted[1]?.fingerprint);
});
