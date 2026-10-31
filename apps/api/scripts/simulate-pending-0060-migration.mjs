import assert from "node:assert/strict";
import { Client } from "pg";

// This deliberately removes migration 0060's schema objects and its ledger row.
// Every later migration row must also be removed, including newer forward-only
// repairs, so Drizzle can replay from 0060 instead of treating a later timestamp
// as already applied.
if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Refusing the pending-0060 simulation outside a GitHub Actions CI runner.");
}
if (process.env.CI_PENDING_0060_TEST !== "1") {
  throw new Error("Refusing the pending-0060 simulation unless CI_PENDING_0060_TEST=1.");
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");

const parsedUrl = new URL(connectionString);
if (!["localhost", "127.0.0.1", "::1", "postgres"].includes(parsedUrl.hostname)) {
  throw new Error(`Refusing to mutate non-local database host: ${parsedUrl.hostname}`);
}

const client = new Client({ connectionString });
await client.connect();
try {
  const identity = await client.query("SELECT current_database() AS database");
  assert.equal(identity.rows[0].database, "affiliateos", "Simulation is restricted to the ephemeral affiliateos CI database.");

  const ledger = await client.query(
    'SELECT created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at ASC'
  );
  const timestamps = ledger.rows.map((row) => Number(row.created_at));
  const migration0059 = 1794050405000;
  const migration0060 = 1794050405001;
  const migration0061 = 1794050405002;
  const migration0062 = 1794050405003;
  const migration0063 = 1794050405004;
  const migration0064 = 1794050405005;
  const migration0065 = 1794050405006;
  const migration0066 = 1794050405007;
  const migration0067 = 1794050405008;
  const migration0068 = 1794050405011;
  const migration0069 = 1794050405012;
  const migration0070 = 1794050405013;
  assert.ok(timestamps.includes(migration0059), "Expected migration 0059 to remain recorded.");
  assert.ok(timestamps.includes(migration0060), "Expected migration 0060 to have been applied before simulation.");
  assert.ok(timestamps.includes(migration0061), "Expected migration 0061 to have been applied before simulation.");
  assert.ok(timestamps.includes(migration0062), "Expected migration 0062 to have been applied before simulation.");
  assert.ok(timestamps.includes(migration0063), "Expected migration 0063 to have been applied before simulation.");
  assert.ok(timestamps.includes(migration0064), "Expected migration 0064 to have been applied before simulation.");
  assert.ok(timestamps.includes(migration0065), "Expected migration 0065 to have been applied before simulation.");
  assert.ok(timestamps.includes(migration0066), "Expected migration 0066 to have been applied before simulation.");
  assert.ok(timestamps.includes(migration0067), "Expected migration 0067 to have been applied before simulation.");
  assert.ok(timestamps.includes(migration0068), "Expected migration 0068 to have been applied before simulation.");
  assert.ok(timestamps.includes(migration0069), "Expected migration 0069 to have been applied before simulation.");
  assert.ok(timestamps.includes(migration0070), "Expected migration 0070 to have been applied before simulation.");

  await client.query("BEGIN");
  try {
    await client.query("DROP INDEX IF EXISTS public.campaigns_test_created_idx");
    await client.query("DROP INDEX IF EXISTS public.autonomous_runs_test_created_idx");
    await client.query("ALTER TABLE public.campaigns DROP COLUMN IF EXISTS is_test");
    await client.query("ALTER TABLE public.autonomous_runs DROP COLUMN IF EXISTS is_test");
    await client.query(
      'DELETE FROM "drizzle"."__drizzle_migrations" WHERE created_at >= $1',
      [migration0060]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const state = await client.query(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='campaigns' AND column_name='is_test') AS campaigns_marker,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='autonomous_runs' AND column_name='is_test') AS runs_marker,
      to_regclass('public.campaigns_test_created_idx') IS NOT NULL AS campaigns_index,
      to_regclass('public.autonomous_runs_test_created_idx') IS NOT NULL AS runs_index
  `);
  assert.deepEqual(state.rows[0], {
    campaigns_marker: false,
    runs_marker: false,
    campaigns_index: false,
    runs_index: false
  });
  console.log("CI database now matches the audited pending-0060 state: 0059 recorded; 0060 and all later migrations absent; 0060 schema objects absent.");
} finally {
  await client.end();
}
