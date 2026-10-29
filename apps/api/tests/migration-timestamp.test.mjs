import assert from "node:assert/strict";
import test from "node:test";
import {
  latestMigrationTimestampIsAfterHistory,
  normalizeLatestMigrationTimestamp
} from "../scripts/migration-timestamp.mjs";

test("normalizes a newly generated timestamp that falls behind the historical maximum", () => {
  const entries = [
    { idx: 0, tag: "old-high", when: 900 },
    { idx: 1, tag: "legacy-out-of-order", when: 100 },
    { idx: 2, tag: "new-migration", when: 200 }
  ];

  const result = normalizeLatestMigrationTimestamp(entries, 500);

  assert.equal(result.changed, true);
  assert.equal(result.timestamp, 901);
  assert.equal(entries[0].when, 900);
  assert.equal(entries[1].when, 100);
  assert.equal(entries[2].when, 901);
});

test("does not rewrite a newest timestamp already greater than the historical maximum", () => {
  const entries = [{ when: 900 }, { when: 100 }, { when: 901 }];
  const result = normalizeLatestMigrationTimestamp(entries, 1000);

  assert.equal(result.changed, false);
  assert.equal(entries[2].when, 901);
});

test("requires only the newest timestamp to exceed all historical timestamps", () => {
  assert.equal(latestMigrationTimestampIsAfterHistory([{ when: 900 }, { when: 100 }, { when: 901 }]), true);
  assert.equal(latestMigrationTimestampIsAfterHistory([{ when: 900 }, { when: 100 }, { when: 899 }]), false);
});

test("rejects invalid timestamps in historical entries instead of rewriting them", () => {
  assert.throws(
    () => normalizeLatestMigrationTimestamp([{ when: "not-a-timestamp" }, { when: 2 }], 10),
    /prior Drizzle migration has an invalid timestamp/
  );
});
