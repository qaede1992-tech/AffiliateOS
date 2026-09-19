import { readFile } from "node:fs/promises";
import { Client } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required. Copy .env.example to .env and start PostgreSQL first.");
}

const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
const trackedMigrations = journal.entries;
if (!Array.isArray(trackedMigrations) || trackedMigrations.length === 0) {
  throw new Error("Drizzle migration journal has no tracked migrations.");
}

const client = new Client({ connectionString });
const expectedTables = [
  "affiliates", "offers", "conversions", "commissions", "marketplaces", "affiliate_accounts",
  "products", "affiliate_offers", "campaigns", "campaign_offers", "tracking_links", "clicks",
  "social_accounts", "content"
];
const expectedIndexes = [
  "tracking_links_campaign_idx", "products_marketplace_external_unique", "commissions_conversion_unique"
];

await client.connect();
try {
  const { rows: tableRows } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
    [expectedTables]
  );
  const actualTables = new Set(tableRows.map((row) => row.table_name));
  const missingTables = expectedTables.filter((table) => !actualTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`Missing expected tables: ${missingTables.join(", ")}.`);
  }

  const { rows: indexRows } = await client.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])",
    [expectedIndexes]
  );
  const actualIndexes = new Set(indexRows.map((row) => row.indexname));
  const missingIndexes = expectedIndexes.filter((index) => !actualIndexes.has(index));
  if (missingIndexes.length > 0) {
    throw new Error(`Missing expected indexes: ${missingIndexes.join(", ")}.`);
  }

  const { rows: migrationTableRows } = await client.query(
    "SELECT table_schema FROM information_schema.tables WHERE table_name = '__drizzle_migrations' ORDER BY table_schema"
  );
  if (migrationTableRows.length === 0) {
    throw new Error("Drizzle migration ledger table does not exist.");
  }
  const migrationSchema = migrationTableRows[0].table_schema;
  const { rows: migrationRows } = await client.query(
    `SELECT COUNT(*)::int AS count FROM "${migrationSchema.replaceAll('"', '""')}"."__drizzle_migrations"`
  );
  const appliedMigrationCount = Number(migrationRows[0]?.count ?? 0);
  if (appliedMigrationCount !== trackedMigrations.length) {
    throw new Error(`Drizzle migration ledger contains ${appliedMigrationCount} migrations, but ${trackedMigrations.length} are tracked.`);
  }

  console.log(`PostgreSQL schema and Drizzle migration ledger verified (${appliedMigrationCount} migrations).`);
} finally {
  await client.end();
}
