import { createHash } from "node:crypto";
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

const migrationDirectory = new URL("../drizzle/", import.meta.url);
const trackedMigrationHashes = [];
for (const migration of trackedMigrations) {
  const migrationPath = new URL(`${migration.tag}.sql`, migrationDirectory);
  const migrationSql = await readFile(migrationPath);
  const hash = createHash("sha256").update(migrationSql).digest("hex");
  trackedMigrationHashes.push({ tag: migration.tag, hash });
}

const client = new Client({ connectionString });
const expectedTables = [
  "affiliates", "offers", "conversions", "commissions", "marketplaces", "affiliate_accounts",
  "products", "affiliate_offers", "campaigns", "campaign_offers", "tracking_links", "clicks",
  "social_accounts", "content", "oauth_states", "conversion_attributions", "provider_events", "publication_jobs", "media_assets", "publication_operations"
];
const expectedIndexes = [
  "tracking_links_campaign_idx", "products_marketplace_external_unique", "commissions_conversion_unique",
  "provider_events_account_external_unique", "provider_events_status_received_idx", "publication_jobs_idempotency_unique", "publication_jobs_due_idx", "publication_operations_provider_operation_unique", "media_assets_content_idx"
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
    `SELECT id, hash FROM "${migrationSchema.replaceAll('"', '""')}"."__drizzle_migrations" ORDER BY id ASC`
  );
  const appliedMigrationHashes = migrationRows.map((row) => row.hash);
  if (appliedMigrationHashes.length !== trackedMigrationHashes.length) {
    throw new Error(`Drizzle migration ledger contains ${appliedMigrationHashes.length} migrations, but ${trackedMigrationHashes.length} are tracked.`);
  }

  const mismatches = trackedMigrationHashes.filter((migration, index) => appliedMigrationHashes[index] !== migration.hash);
  if (mismatches.length > 0) {
    const details = mismatches.map((migration) => `${migration.tag} (${migration.hash})`).join(", ");
    throw new Error(`Drizzle migration ledger hashes do not match tracked migration files: ${details}.`);
  }

  console.log(`PostgreSQL schema and Drizzle migration ledger verified (${appliedMigrationHashes.length} migrations, hashes match).`);
} finally {
  await client.end();
}
