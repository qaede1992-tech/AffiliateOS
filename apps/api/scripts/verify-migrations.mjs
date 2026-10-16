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
  const expectedGapTags = [
    "0056_tiktok_publication_approval_and_media_duration",
    "0057_content_products_multi_product_story"
  ];
  const compensatedTags = new Set();
  const exactHistoricalGapSet =
    missingMigrations.length === expectedGapTags.length &&
    expectedGapTags.every((tag) => missingMigrations.includes(tag));
  if (
    exactHistoricalGapSet &&
    compensationTimestamp !== null &&
    appliedTimestamps.has(compensationTimestamp) &&
    schemaObjectsPresent
  ) {
    return new Set(expectedGapTags);
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
assert.equal(findCompensatedMigrationGaps({
  missingMigrations: ["0056_tiktok_publication_approval_and_media_duration"],
  compensationTimestamp: 200,
  appliedTimestamps: new Set([200]),
  schemaObjectsPresent: true
}).size, 0);
assert.equal(findCompensatedMigrationGaps({
  missingMigrations: ["0057_content_products_multi_product_story"],
  compensationTimestamp: 200,
  appliedTimestamps: new Set([200]),
  schemaObjectsPresent: true
}).size, 0);
assert.equal(findCompensatedMigrationGaps({
  missingMigrations: [
    "0056_tiktok_publication_approval_and_media_duration",
    "0057_content_products_multi_product_story",
    "0001_affiliateos_foundation"
  ],
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
  ["publication_jobs", "confirmed_at"],
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
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND (table_name, column_name) IN (('publication_jobs', 'confirmed_at'), ('publication_jobs', 'tiktok_approval'), ('media_assets', 'duration_seconds'))"
  );
  const actualColumns = new Set(columnRows.map((row) => `${row.table_name}.${row.column_name}`));
  const missingColumns = expectedColumns
    .map(([table, column]) => `${table}.${column}`)
    .filter((column) => !actualColumns.has(column));
  if (missingColumns.length > 0) {
    errors.push(`Missing expected columns: ${missingColumns.join(", ")}.`);
  }

  // Verify the reconciled objects' definitions, not only their names. This is
  // intentionally read-only and fails closed on incompatible partial schemas.
  const { rows: repairedColumnRows } = await client.query(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'publication_jobs' AND column_name = 'confirmed_at')
          OR (table_name = 'publication_jobs' AND column_name = 'tiktok_approval')
          OR (table_name = 'media_assets' AND column_name = 'duration_seconds'))`
  );
  const repairedColumns = new Map(repairedColumnRows.map((row) => [
    `${row.table_name}.${row.column_name}`, row
  ]));
  for (const [key, expected] of [
    ["publication_jobs.confirmed_at", { data_type: "timestamp with time zone", udt_name: "timestamptz", is_nullable: "YES" }],
    ["publication_jobs.tiktok_approval", { data_type: "jsonb", udt_name: "jsonb", is_nullable: "YES" }],
    ["media_assets.duration_seconds", { data_type: "integer", udt_name: "int4", is_nullable: "YES" }]
  ]) {
    const actual = repairedColumns.get(key);
    if (!actual) {
      errors.push(`Missing required column definition: ${key}.`);
      continue;
    }
    for (const [property, value] of Object.entries(expected)) {
      if (actual[property] !== value) {
        errors.push(`Incompatible definition for ${key}: expected ${property}=${value}, found ${actual[property]}.`);
      }
    }
  }

  const { rows: contentProductColumnRows } = await client.query(
    `SELECT column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'content_products'`
  );
  const contentProductColumns = new Map(contentProductColumnRows.map((row) => [row.column_name, row]));
  const expectedContentProductColumns = {
    content_id: { data_type: "uuid", udt_name: "uuid", is_nullable: "NO" },
    product_id: { data_type: "uuid", udt_name: "uuid", is_nullable: "NO" },
    affiliate_offer_id: { data_type: "uuid", udt_name: "uuid", is_nullable: "YES" },
    position: { data_type: "integer", udt_name: "int4", is_nullable: "NO", defaultIncludes: "0" },
    role: { data_type: "character varying", udt_name: "varchar", is_nullable: "NO", defaultIncludes: "recommendation" },
    created_at: { data_type: "timestamp with time zone", udt_name: "timestamptz", is_nullable: "NO" }
  };
  for (const [column, expected] of Object.entries(expectedContentProductColumns)) {
    const actual = contentProductColumns.get(column);
    if (!actual) {
      errors.push(`content_products is missing required column ${column}.`);
      continue;
    }
    for (const [property, value] of Object.entries(expected)) {
      if (property === "defaultIncludes") {
        if (!actual.column_default?.includes(value)) {
          errors.push(`content_products.${column} has unexpected default: ${actual.column_default}.`);
        }
      } else if (actual[property] !== value) {
        errors.push(`content_products.${column} expected ${property}=${value}, found ${actual[property]}.`);
      }
    }
  }

  const { rows: contentProductConstraints } = await client.query(
    `SELECT c.conname, c.contype, pg_get_constraintdef(c.oid, true) AS definition,
            tn.nspname AS referenced_schema, t.relname AS referenced_table
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace rn ON rn.oid = r.relnamespace
       LEFT JOIN pg_class t ON t.oid = c.confrelid
       LEFT JOIN pg_namespace tn ON tn.oid = t.relnamespace
      WHERE rn.nspname = 'public' AND r.relname = 'content_products' AND c.contype IN ('f', 'u')`
  );
  const normalizeConstraintDefinition = (definition) =>
    definition.toLowerCase().replaceAll('"', "").replace(/\s+/g, " ").trim();
  const hasForeignKey = (column, table) => contentProductConstraints.some((constraint) =>
    constraint.contype === "f" &&
    constraint.referenced_schema === "public" &&
    constraint.referenced_table === table &&
    normalizeConstraintDefinition(constraint.definition).includes(
      `foreign key (${column}) references ${table}(id)`
    )
  );
  for (const [column, table] of [["content_id", "content"], ["product_id", "products"], ["affiliate_offer_id", "affiliate_offers"]]) {
    if (!hasForeignKey(column, table)) {
      errors.push(`content_products.${column} is missing its expected foreign key to public.${table}(id).`);
    }
  }
  if (!contentProductConstraints.some((constraint) =>
    constraint.contype === "u" &&
    normalizeConstraintDefinition(constraint.definition).includes("unique (content_id, product_id)")
  )) {
    errors.push("content_products is missing its unique constraint on (content_id, product_id).");
  }

  const { rows: contentProductIndexRows } = await client.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'content_products'`
  );
  const contentProductIndexDefs = new Map(contentProductIndexRows.map((row) => [
    row.indexname, normalizeConstraintDefinition(row.indexdef)
  ]));
  for (const [name, requiredColumns] of [
    ["content_products_product_idx", "(product_id)"],
    ["content_products_offer_idx", "(affiliate_offer_id)"],
    ["content_products_content_position_idx", "(content_id, position)"]
  ]) {
    const definition = contentProductIndexDefs.get(name);
    if (!definition || !definition.includes(requiredColumns)) {
      errors.push(`Missing or incompatible index definition for ${name}; expected columns ${requiredColumns}.`);
    }
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
