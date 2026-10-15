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

const errors = [];
const migrationByTimestamp = new Map();
const trackedMigrationHashes = new Map();

for (const migration of trackedMigrations) {
  const timestamp = Number(migration.when);
  if (!Number.isSafeInteger(timestamp)) {
    errors.push(`Migration ${migration.tag} has an invalid timestamp: ${migration.when}.`);
    continue;
  }
  if (migrationByTimestamp.has(timestamp)) {
    errors.push(`Journal timestamp ${timestamp} is duplicated by ${migrationByTimestamp.get(timestamp).tag} and ${migration.tag}.`);
    continue;
  }

  const migrationPath = new URL(`${migration.tag}.sql`, new URL("../drizzle/", import.meta.url));
  const migrationSql = await readFile(migrationPath);
  const hash = createHash("sha256").update(migrationSql).digest("hex");
  migrationByTimestamp.set(timestamp, migration);
  trackedMigrationHashes.set(timestamp, { tag: migration.tag, hash });
}

const client = new Client({ connectionString });
const expectedTables = [
  "affiliates", "offers", "conversions", "commissions", "marketplaces", "affiliate_accounts",
  "products", "affiliate_offers", "campaigns", "campaign_offers", "tracking_links", "clicks",
  "social_accounts", "content", "oauth_states", "conversion_attributions", "provider_events",
  "publication_jobs", "media_assets", "publication_operations", "content_products"
];
const expectedIndexes = [
  "tracking_links_campaign_idx", "products_marketplace_external_unique", "commissions_conversion_unique",
  "provider_events_account_external_unique", "provider_events_status_received_idx",
  "publication_jobs_idempotency_unique", "publication_jobs_due_idx",
  "publication_operations_provider_operation_unique", "media_assets_content_idx",
  "content_products_product_idx", "content_products_offer_idx", "content_products_content_position_idx"
];
const expectedColumns = [
  ["publication_jobs", "tiktok_approval"],
  ["media_assets", "duration_seconds"]
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
    errors.push(`Missing expected tables: ${missingTables.join(", ")}.`);
  }

  const { rows: indexRows } = await client.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])",
    [expectedIndexes]
  );
  const actualIndexes = new Set(indexRows.map((row) => row.indexname));
  const missingIndexes = expectedIndexes.filter((index) => !actualIndexes.has(index));
  if (missingIndexes.length > 0) {
    errors.push(`Missing expected indexes: ${missingIndexes.join(", ")}.`);
  }

  const { rows: columnRows } = await client.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND (table_name, column_name) IN (('publication_jobs', 'tiktok_approval'), ('media_assets', 'duration_seconds'))"
  );
  const actualColumns = new Set(columnRows.map((row) => `${row.table_name}.${row.column_name}`));
  const missingColumns = expectedColumns
    .map(([table, column]) => `${table}.${column}`)
    .filter((column) => !actualColumns.has(column));
  if (missingColumns.length > 0) {
    errors.push(`Missing expected columns: ${missingColumns.join(", ")}.`);
  }

  const { rows: migrationTableRows } = await client.query(
    "SELECT table_schema FROM information_schema.tables WHERE table_name = '__drizzle_migrations' ORDER BY table_schema"
  );
  if (migrationTableRows.length === 0) {
    errors.push("Drizzle migration ledger table does not exist.");
  } else {
    const migrationSchema = migrationTableRows[0].table_schema.replaceAll('"', '""');
    const { rows: migrationRows } = await client.query(
      `SELECT id, hash, created_at FROM "${migrationSchema}"."__drizzle_migrations" ORDER BY id ASC`
    );

    const appliedTimestamps = new Set();
    for (const row of migrationRows) {
      const timestamp = Number(row.created_at);
      if (!Number.isSafeInteger(timestamp)) {
        errors.push(`Ledger row id=${row.id} has invalid created_at timestamp ${row.created_at}.`);
        continue;
      }
      if (appliedTimestamps.has(timestamp)) {
        errors.push(`Ledger contains duplicate created_at timestamp ${timestamp}.`);
        continue;
      }
      appliedTimestamps.add(timestamp);

      const tracked = trackedMigrationHashes.get(timestamp);
      if (!tracked) {
        errors.push(`Ledger row id=${row.id} has timestamp ${timestamp}, which is absent from the checked-out migration journal.`);
        continue;
      }
      if (row.hash !== tracked.hash) {
        errors.push(`Hash mismatch for ${tracked.tag} at timestamp ${timestamp}: ledger hash does not match the checked-out SQL file.`);
      }
    }

    const missingMigrations = [...migrationByTimestamp.entries()]
      .filter(([timestamp]) => !appliedTimestamps.has(timestamp))
      .map(([, migration]) => migration.tag);
    if (missingMigrations.length > 0) {
      errors.push(`Journal migrations missing from the database ledger: ${missingMigrations.join(", ")}.`);
    }

    if (migrationRows.length !== trackedMigrations.length) {
      errors.push(`Drizzle migration ledger contains ${migrationRows.length} rows, but the checked-out journal contains ${trackedMigrations.length} entries.`);
    }
  }
} finally {
  await client.end();
}

if (errors.length > 0) {
  throw new Error(`PostgreSQL schema and Drizzle migration ledger verification failed:\n- ${errors.join("\n- ")}`);
}

console.log(`PostgreSQL schema and Drizzle migration ledger verified (${trackedMigrations.length} migrations; timestamp-based hash matching passed).`);
