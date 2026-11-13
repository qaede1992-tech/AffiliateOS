import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMigrationLedger,
  findCompensatedHistoricalMigrationGaps,
  getPendingMigrationSchemaExemptions
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
  assert.equal(result.latestAppliedIndex, 1);
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

test("preflight uses journal order when migration timestamps are non-monotonic", () => {
  const nonMonotonicMigrations = [
    { tag: "0001_applied", when: 100 },
    { tag: "0002_historical_gap", when: 500 },
    { tag: "0003_applied_after_gap", when: 200 },
    { tag: "0004_pending", when: 600 }
  ];

  const result = classifyMigrationLedger({
    trackedMigrations: nonMonotonicMigrations,
    appliedTimestamps: new Set([100, 200])
  });

  assert.deepEqual(result.pendingMigrations.map((item) => item.tag), ["0004_pending"]);
  assert.deepEqual(result.historicalMissingMigrations.map((item) => item.tag), ["0002_historical_gap"]);
  assert.equal(result.latestAppliedTimestamp, 200);
  assert.equal(result.latestAppliedIndex, 2);
});

test("preflight rejects ledger timestamps absent from the checked-out journal", () => {
  assert.throws(
    () => classifyMigrationLedger({ trackedMigrations: migrations, appliedTimestamps: new Set([100, 999]) }),
    /absent from the checked-out journal/
  );
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


test("pending schema exemptions are limited to objects created by the exact pending migration", () => {
  const known = getPendingMigrationSchemaExemptions(new Set(["0060_test_data_retention_markers"]));
  assert.deepEqual([...known.columns].sort(), ["autonomous_runs.is_test", "campaigns.is_test"]);
  assert.deepEqual([...known.indexes].sort(), ["autonomous_runs_test_created_idx", "campaigns_test_created_idx"]);

  const unknown = getPendingMigrationSchemaExemptions(new Set(["0088_unreviewed_schema_change"]));
  assert.equal(unknown.columns.size, 0);
  assert.equal(unknown.indexes.size, 0);

  const verificationIndex = getPendingMigrationSchemaExemptions(
    new Set(["0088_affiliate_offers_verification_cursor_index"])
  );
  assert.equal(verificationIndex.columns.size, 0);
  assert.deepEqual([...verificationIndex.indexes], ["affiliate_offers_verification_cursor_idx"]);
});
