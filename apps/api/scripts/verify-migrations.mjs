import assert from "node:assert/strict";
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

function findCompensatedMigrationGaps({ missingMigrations, compensationTimestamp, appliedTimestamps, schemaObjectsPresent }) {
  const compensatedTags = new Set();
  if (compensationTimestamp !== null && appliedTimestamps.has(compensationTimestamp) && schemaObjectsPresent) {
    for (const tag of [
      "0056_tiktok_publication_approval_and_media_duration",
      "0057_content_products_multi_product_story"
    ]) {
      if (missingMigrations.includes(tag)) compensatedTags.add(tag);
    }
  }
  return compensatedTags;
}

// Fail closed if the historical-gap exception is accidentally broadened.
const fixtureMissing = [
  "0056_tiktok_publication_approval_and_media_duration",
  "0057_content_products_multi_product_story"
];
assert.equal(findCompensatedMigrationGaps({
  missingMigrations: fixtureMissing,
  compensationTimestamp: 200,
  appliedTimestamps: new Set([200]),
  schemaObjectsPresent: true
}).size, 2);
assert.equal(findCompensatedMigrationGaps({
  missingMigrations: fixtureMissing,
  compensationTimestamp: 200,
  appliedTimestamps: new Set(),
  schemaObjectsPresent: true
}).size, 0);
assert.equal(findCompensatedMigrationGaps({
  missingMigrations: fixtureMissing,
  compensationTimestamp: 200,
  appliedTimestamps: new Set([200]),
  schemaObjectsPresent: false
}).size, 0);
assert.equal(findCompensatedMigrationGaps({
  missingMigrations: ["0001_affiliateos_foundation"],
  compensationTimestamp: 200,
  appliedTimestamps: new Set([200]),
  schemaObjectsPresent: true
}).size, 0);

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
  const sqlText = migrationSql.toString("utf8");
  // Drizzle hashes the exact file bytes. Production migrations may have been
  // applied from Windows checkouts (CRLF), while CI checks out LF files.
  // Accept only hashes for byte-identical SQL with LF/CRLF line-ending styles.
  const lfSql = sqlText.replace(/\r\n/g, "\n");
  const hashVariants = new Set([
    createHash("sha256").update(migrationSql).digest("hex"),
    createHash("sha256").update(lfSql, "utf8").digest("hex"),
    createHash("sha256").update(lfSql.replace(/\n/g, "\r\n"), "utf8").digest("hex")
  ]);
  migrationByTimestamp.set(timestamp, migration);
  trackedMigrationHashes.set(timestamp, { tag: migration.tag, hashes: hashVariants });
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
  if (migrationTableRows.length !== 1) {
    errors.push(`Expected exactly one Drizzle migration ledger table, found ${migrationTableRows.length}; refusing to select a schema implicitly.`);
  } else if (migrationTableRows[0].table_schema !== "drizzle") {
    errors.push(`Expected Drizzle migration ledger in schema "drizzle", found schema "${migrationTableRows[0].table_schema}".`);
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
      if (!tracked.hashes.has(row.hash)) {
        errors.push(`Hash mismatch for ${tracked.tag} at timestamp ${timestamp}: ledger hash does not match the checked-out SQL file under LF or CRLF line endings.`);
      }
    }

    const missingMigrations = [...migrationByTimestamp.entries()]
      .filter(([timestamp]) => !appliedTimestamps.has(timestamp))
      .map(([, migration]) => migration.tag);

    // Production's audited ledger has historical gaps for 0056/0057. Accept
    // those two exact gaps only when the forward-only 0059 reconciliation is
    // recorded, its SQL hash passed the check above, and every required schema
    // object is present. This does not insert or fabricate historical ledger rows.
    const compensationTag = "0059_reconcile_missing_tiktok_and_content_products";
    const compensationMigration = trackedMigrations.find((migration) => migration.tag === compensationTag);
    const compensationTimestamp = compensationMigration ? Number(compensationMigration.when) : null;
    const schemaObjectsPresent =
      missingTables.length === 0 && missingIndexes.length === 0 && missingColumns.length === 0;
    const compensatedTags = findCompensatedMigrationGaps({
      missingMigrations,
      compensationTimestamp,
      appliedTimestamps,
      schemaObjectsPresent
    });

    const uncompensatedMigrations = missingMigrations.filter((tag) => !compensatedTags.has(tag));
    if (uncompensatedMigrations.length > 0) {
      errors.push(`Journal migrations missing from the database ledger without an approved compensation: ${uncompensatedMigrations.join(", ")}.`);
    }

    const expectedLedgerRows = trackedMigrations.length - compensatedTags.size;
    if (migrationRows.length !== expectedLedgerRows) {
      errors.push(`Drizzle migration ledger contains ${migrationRows.length} rows; expected ${expectedLedgerRows} rows for ${trackedMigrations.length} journal entries and ${compensatedTags.size} explicitly compensated historical gaps.`);
    }
    if (compensatedTags.size > 0) {
      console.warn(`Historical migration ledger gaps explicitly compensated by ${compensationTag}: ${[...compensatedTags].join(", ")}. Original ledger history remains unchanged.`);
    }
  }
} finally {
  await client.end();
}

if (errors.length > 0) {
  throw new Error(`PostgreSQL schema and Drizzle migration ledger verification failed:\n- ${errors.join("\n- ")}`);
}

console.log(`PostgreSQL schema and Drizzle migration ledger verified (${trackedMigrations.length} migrations; timestamp-based hash matching passed).`);
