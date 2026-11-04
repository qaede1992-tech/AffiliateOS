import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeLatestMigrationTimestamp } from "./migration-timestamp.mjs";

const journalPath = resolve(import.meta.dirname, "../drizzle/meta/_journal.json");
const journal = JSON.parse(await readFile(journalPath, "utf8"));
const result = normalizeLatestMigrationTimestamp(journal.entries);

if (result.changed) {
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  console.log(`Normalized newest migration timestamp from ${result.previousTimestamp} to ${result.timestamp}.`);
} else {
  console.log("Newest migration timestamp already exceeds every prior timestamp; no journal changes made.");
}
