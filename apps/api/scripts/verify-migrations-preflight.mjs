import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  classifyMigrationLedger,
  findCompensatedHistoricalMigrationGaps
} from "./migration-ledger-preflight.mjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for the read-only migration preflight.");
}

const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
const trackedMigrations = journal.entries;
if (!Array.isArray(trackedMigrations) || trackedMigrations.length === 0) {
  throw new Error("Drizzle migration journal has no tracked migrations.");
}

const migrationByTimestamp = new Map();
const trackedMigrationHashes = new Map();
for (const migration of trackedMigrations) {
  const timestamp = Number(migration.when);
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error(`Migration ${migration.tag} has an invalid timestamp: ${migration.when}.`);
  }
  if (migrationByTimestamp.has(timestamp)) {
    throw new Error(`Journal timestamp ${timestamp} is duplicated by ${migrationByTimestamp.get(timestamp).tag} and ${migration.tag}.`);
  }

  const migrationPath = new URL(`${migration.tag}.sql`, new URL("../drizzle/", import.meta.url));
  const migrationBytes = await readFile(migrationPath);
  const sqlText = migrationBytes.toString("utf8");
  const lfSql = sqlText.replace(/\r\n/g, "\n");
  const hashes = new Set([
    createHash("sha256").update(migrationBytes).digest("hex"),
    createHash("sha256").update(lfSql, "utf8").digest("hex"),
    createHash("sha256").update(lfSql.replace(/\n/g, "\r\n"), "utf8").digest("hex")
  ]);
  migrationByTimestamp.set(timestamp, migration);
  trackedMigrationHashes.set(timestamp, { tag: migration.tag, hashes });
}

const client = new Client({ connectionString, connectionTimeoutMillis: 10000 });
await client.connect();
try {
  await client.query("SET default_transaction_read_only = on");

  const { rows: ledgerTables } = await client.query(
    "SELECT table_schema FROM information_schema.tables WHERE table_name = '__drizzle_migrations' ORDER BY table_schema"
  );
  if (ledgerTables.length !== 1 || ledgerTables[0].table_schema !== "drizzle") {
    throw new Error(
      `Expected exactly one Drizzle migration ledger in schema "drizzle"; found ${ledgerTables.map((row) => row.table_schema).join(", ") || "none"}.`
    );
  }

  const { rows: migrationRows } = await client.query(
    'SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id ASC'
  );
  if (migrationRows.length === 0) {
    throw new Error("Production Drizzle migration ledger is empty; refusing to treat an uninitialized database as a pending migration suffix.");
  }

  const appliedTimestamps = new Set();
  const ledgerErrors = [];
  for (const row of migrationRows) {
    const timestamp = Number(row.created_at);
    if (!Number.isSafeInteger(timestamp)) {
      ledgerErrors.push(`Ledger row id=${row.id} has invalid created_at timestamp ${row.created_at}.`);
      continue;
    }
    if (appliedTimestamps.has(timestamp)) {
      ledgerErrors.push(`Ledger contains duplicate created_at timestamp ${timestamp}.`);
      continue;
    }
    appliedTimestamps.add(timestamp);

    const tracked = trackedMigrationHashes.get(timestamp);
    if (!tracked) {
      ledgerErrors.push(`Ledger row id=${row.id} has timestamp ${timestamp}, which is absent from the checked-out migration journal.`);
      continue;
    }
    if (!tracked.hashes.has(row.hash)) {
      ledgerErrors.push(`Hash mismatch for ${tracked.tag} at timestamp ${timestamp}; refusing to run pending migrations.`);
    }
  }
  if (ledgerErrors.length > 0) {
    throw new Error(`Production migration ledger preflight failed:\n- ${ledgerErrors.join("\n- ")}`);
  }

  const {
    pendingMigrations,
    historicalMissingMigrations,
    latestAppliedTimestamp
  } = classifyMigrationLedger({ trackedMigrations, appliedTimestamps });

  const compensationMigration = trackedMigrations.find(
    (migration) => migration.tag === "0059_reconcile_missing_tiktok_and_content_products"
  );
  const forwardRepairMigration = trackedMigrations.find(
    (migration) => migration.tag === "0069_forward_repair_missing_tiktok_and_content_products"
  );
  const compensatedTags = findCompensatedHistoricalMigrationGaps({
    missingMigrations: historicalMissingMigrations.map((migration) => migration.tag),
    appliedTimestamps,
    compensationTimestamp: compensationMigration ? Number(compensationMigration.when) : null,
    forwardRepairTimestamp: forwardRepairMigration ? Number(forwardRepairMigration.when) : null
  });

  const uncompensatedMigrations = historicalMissingMigrations
    .map((migration) => migration.tag)
    .filter((tag) => !compensatedTags.has(tag));
  if (uncompensatedMigrations.length > 0) {
    throw new Error(
      `Historical migration gaps are not an approved compensated set: ${uncompensatedMigrations.join(", ")}. No pending migration was applied.`
    );
  }

  const classifiedCount =
    migrationRows.length + pendingMigrations.length + compensatedTags.size;
  if (classifiedCount !== trackedMigrations.length) {
    throw new Error(
      `Migration classification mismatch: ledger=${migrationRows.length}, pending=${pendingMigrations.length}, compensated=${compensatedTags.size}, journal=${trackedMigrations.length}.`
    );
  }

  console.log(
    `Read-only production migration preflight passed: ${migrationRows.length} ledger rows hash-verified; latest applied timestamp ${latestAppliedTimestamp}; ${pendingMigrations.length} newer pending migration(s); ${compensatedTags.size} explicitly compensated historical gap(s).`
  );
  if (pendingMigrations.length > 0) {
    console.log(`Pending migration suffix: ${pendingMigrations.map((migration) => migration.tag).join(", ")}`);
  }
  if (compensatedTags.size > 0) {
    console.warn(`Historical ledger gaps accepted only through recorded forward repairs: ${[...compensatedTags].join(", ")}.`);
  }
} finally {
  await client.end();
}
