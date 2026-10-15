import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const journalPath = "apps/api/drizzle/meta/_journal.json";
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
const baseEntries = baseJournal.entries;
const headEntries = headJournal.entries;

if (!Array.isArray(baseEntries) || !Array.isArray(headEntries)) {
  throw new Error("Both base and head migration journals must contain entries arrays.");
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
  console.log("No new migration journal entries; timestamp guard passed.");
  process.exit(0);
}

const baseMaxTimestamp = Math.max(...baseEntries.map((entry) => Number(entry.when)));
if (!Number.isFinite(baseMaxTimestamp)) {
  throw new Error("Could not determine the maximum timestamp in the base migration journal.");
}

let previousTimestamp = baseMaxTimestamp;
for (const [offset, entry] of newEntries.entries()) {
  const timestamp = Number(entry.when);
  if (!Number.isSafeInteger(timestamp) || timestamp <= previousTimestamp) {
    throw new Error(
      `New migration ${entry.tag} has timestamp ${entry.when}; each new migration must be strictly greater than the previous maximum ${previousTimestamp}. Choose a fresh timestamp and never edit existing migration history.`,
    );
  }
  previousTimestamp = timestamp;
  console.log(`Validated new migration ${entry.tag}: ${timestamp} > ${offset === 0 ? baseMaxTimestamp : Number(newEntries[offset - 1].when)}`);
}

console.log(
  `Migration timestamp guard passed: ${newEntries.length} new migration(s) are strictly newer than the base journal maximum ${baseMaxTimestamp}.`,
);
