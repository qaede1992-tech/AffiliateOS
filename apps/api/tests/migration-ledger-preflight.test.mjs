import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMigrationLedger,
  findCompensatedHistoricalMigrationGaps
} from "../scripts/migration-ledger-preflight.mjs";

const migrations = [
  { tag: "0001_initial", when: 100 },
  { tag: "0002_existing", when: 200 },
  { tag: "0003_new", when: 300 },
  { tag: "0004_newer", when: 400 }
];

test("preflight accepts only a contiguous suffix of newer pending migrations", () => {
  const result = classifyMigrationLedger({
    trackedMigrations: migrations,
    appliedTimestamps: new Set([100, 200])
  });

  assert.deepEqual(result.pendingMigrations.map((item) => item.tag), ["0003_new", "0004_newer"]);
  assert.deepEqual(result.historicalMissingMigrations, []);
  assert.equal(result.latestAppliedTimestamp, 200);
});

test("preflight classifies a missing migration before the latest applied timestamp as historical drift", () => {
  const result = classifyMigrationLedger({
    trackedMigrations: migrations,
    appliedTimestamps: new Set([100, 300, 400])
  });

  assert.deepEqual(result.pendingMigrations, []);
  assert.deepEqual(result.historicalMissingMigrations.map((item) => item.tag), ["0002_existing"]);
});

test("preflight separates historical drift from a newer pending suffix", () => {
  const result = classifyMigrationLedger({
    trackedMigrations: migrations,
    appliedTimestamps: new Set([100, 300])
  });

  assert.deepEqual(result.pendingMigrations.map((item) => item.tag), ["0004_newer"]);
  assert.deepEqual(result.historicalMissingMigrations.map((item) => item.tag), ["0002_existing"]);
});

test("preflight refuses an empty ledger instead of treating the whole journal as pending", () => {
  assert.throws(
    () => classifyMigrationLedger({ trackedMigrations: migrations, appliedTimestamps: new Set() }),
    /ledger is empty/
  );
});

test("legacy 0056/0057 gaps are compensated only as an exact pair with 0059 recorded", () => {
  const legacy = [
    "0056_tiktok_publication_approval_and_media_duration",
    "0057_content_products_multi_product_story"
  ];
  assert.deepEqual(
    [...findCompensatedHistoricalMigrationGaps({
      missingMigrations: legacy,
      appliedTimestamps: new Set([590]),
      compensationTimestamp: 590,
      forwardRepairTimestamp: 690
    })].sort(),
    [...legacy].sort()
  );
  assert.equal(findCompensatedHistoricalMigrationGaps({
    missingMigrations: legacy,
    appliedTimestamps: new Set(),
    compensationTimestamp: 590,
    forwardRepairTimestamp: 690
  }).size, 0);
  assert.equal(findCompensatedHistoricalMigrationGaps({
    missingMigrations: [legacy[0]],
    appliedTimestamps: new Set([590]),
    compensationTimestamp: 590,
    forwardRepairTimestamp: 690
  }).size, 0);
});

test("the 0067 historical gap is compensated only when 0069 is recorded", () => {
  const gap = "0067_reconcile_drifted_tiktok_and_content_products";
  assert.equal(findCompensatedHistoricalMigrationGaps({
    missingMigrations: [gap],
    appliedTimestamps: new Set([690]),
    compensationTimestamp: 590,
    forwardRepairTimestamp: 690
  }).has(gap), true);
  assert.equal(findCompensatedHistoricalMigrationGaps({
    missingMigrations: [gap],
    appliedTimestamps: new Set(),
    compensationTimestamp: 590,
    forwardRepairTimestamp: 690
  }).size, 0);
});
