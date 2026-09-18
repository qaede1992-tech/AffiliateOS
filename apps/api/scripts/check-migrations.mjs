import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const migrationsDirectory = resolve(import.meta.dirname, "../drizzle");
const journalPath = resolve(migrationsDirectory, "meta/_journal.json");
const journal = JSON.parse(await readFile(journalPath, "utf8"));
const entries = journal.entries;

if (!Array.isArray(entries) || entries.length === 0) {
  throw new Error("Drizzle migration journal has no entries.");
}

const files = new Set((await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")));
for (const [index, entry] of entries.entries()) {
  if (entry.idx !== index) {
    throw new Error(`Migration journal index ${entry.idx} must equal its position ${index}.`);
  }
  const filename = `${entry.tag}.sql`;
  if (!files.delete(filename)) {
    throw new Error(`Migration journal entry ${entry.tag} has no SQL file.`);
  }
}

if (files.size > 0) {
  throw new Error(`Migration SQL file(s) missing from the journal: ${[...files].join(", ")}.`);
}

const foundationSql = await readFile(resolve(migrationsDirectory, "0001_affiliateos_foundation.sql"), "utf8");
const expectedFoundationTables = [
  "marketplaces", "affiliate_accounts", "products", "affiliate_offers", "campaigns",
  "campaign_offers", "tracking_links", "clicks", "social_accounts", "content"
];
for (const table of expectedFoundationTables) {
  if (!foundationSql.includes(`CREATE TABLE IF NOT EXISTS "${table}"`)) {
    throw new Error(`Foundation migration does not create ${table}.`);
  }
}

const indexSql = await readFile(resolve(migrationsDirectory, "0002_tracking_links_campaign_index.sql"), "utf8");
if (!indexSql.includes('CREATE INDEX IF NOT EXISTS "tracking_links_campaign_idx"')) {
  throw new Error("The tracking_links campaign index migration is missing.");
}

console.log(`Migration history is internally consistent (${entries.length} migrations).`);
