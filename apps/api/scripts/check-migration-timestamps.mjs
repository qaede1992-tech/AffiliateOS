import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const journalPath = "apps/api/drizzle/meta/_journal.json";

function validateMigrationTimestamps(baseJournal, headJournal) {
  const baseEntries = baseJournal.entries;
  const headEntries = headJournal.entries;

  if (!Array.isArray(baseEntries) || !Array.isArray(headEntries) || baseEntries.length === 0) {
    throw new Error("Both base and head migration journals must contain non-empty entries arrays.");
  }
  if (headEntries.length < baseEntries.length) {
    throw new Error("Migration journal entries were removed. Migration history must be append-only.");
  }

  for (let index = 0; index < baseEntries.length; index += 1) {
    if (JSON.stringify(headEntries[index]) !== JSON.stringify(baseEntries[index])) {
      throw new Error(
        `Existing migration journal entry at index ${index} was changed. Do not rewrite prior migration timestamps or history.`,
      );
    }
  }

  const newEntries = headEntries.slice(baseEntries.length);
  if (newEntries.length === 0) {
    return { newEntries, baseMaxTimestamp: Math.max(...baseEntries.map((entry) => Number(entry.when))) };
  }

  const baseMaxTimestamp = Math.max(...baseEntries.map((entry) => Number(entry.when)));
  if (!Number.isSafeInteger(baseMaxTimestamp)) {
    throw new Error("Could not determine the maximum timestamp in the base migration journal.");
  }

  let previousTimestamp = baseMaxTimestamp;
  for (const entry of newEntries) {
    const timestamp = Number(entry.when);
    if (!Number.isSafeInteger(timestamp) || timestamp <= previousTimestamp) {
      throw new Error(
        `New migration ${entry.tag} has timestamp ${entry.when}; each new migration must be strictly greater than the previous maximum ${previousTimestamp}. Choose a fresh timestamp and never edit existing migration history.`,
      );
    }
    previousTimestamp = timestamp;
  }

  return { newEntries, baseMaxTimestamp };
}

// Exercise the pass and fail paths on every CI run so a regression in this guard is detected.
const fixtureBase = { entries: [{ idx: 0, tag: "0000_fixture", when: 100 }] };
assert.doesNotThrow(() =>
  validateMigrationTimestamps(fixtureBase, {
    entries: [
      ...fixtureBase.entries,
      { idx: 1, tag: "0001_fixture", when: 101 },
      { idx: 2, tag: "0002_fixture", when: 102 },
    ],
  }),
);
assert.throws(
  () =>
    validateMigrationTimestamps(fixtureBase, {
      entries: [...fixtureBase.entries, { idx: 1, tag: "0001_regression", when: 99 }],
    }),
  /strictly greater/,
);
assert.throws(
  () =>
    validateMigrationTimestamps(fixtureBase, {
      entries: [{ idx: 0, tag: "0000_fixture", when: 99 }],
    }),
  /Existing migration journal entry/,
);

const baseSha = process.env.BASE_SHA;
if (!baseSha || !/^[0-9a-f]{40}$/i.test(baseSha)) {
  throw new Error("BASE_SHA must be a full Git commit SHA so migration timestamps can be compared with the base journal.");
}

const baseJournalText = execFileSync("git", ["show", `${baseSha}:${journalPath}`], {
  encoding: "utf8",
});
const headJournalText = await readFile(resolve(journalPath), "utf8");
const baseJournal = JSON.parse(baseJournalText);
const headJournal = JSON.parse(headJournalText);
const { newEntries, baseMaxTimestamp } = validateMigrationTimestamps(baseJournal, headJournal);

if (newEntries.length === 0) {
  console.log("Migration timestamp guard self-tests passed; no new migration journal entries in this change.");
  process.exit(0);
}

for (const entry of newEntries) {
  console.log(`Validated new migration ${entry.tag}: ${entry.when} (must be above base maximum ${baseMaxTimestamp}).`);
}

console.log(
  `Migration timestamp guard passed: ${newEntries.length} new migration(s) are strictly newer than the base journal maximum ${baseMaxTimestamp}.`,
);
