import assert from "node:assert/strict";
import { Client } from "pg";

if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Refusing destructive migration-drift simulation outside a GitHub Actions CI runner.");
}
if (process.env.CI_MIGRATION_DRIFT_TEST !== "1") {
  throw new Error("Refusing destructive migration-drift simulation unless CI_MIGRATION_DRIFT_TEST=1.");
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
  const identity = await client.query("SELECT current_database() AS database, current_user AS role");
  assert.equal(identity.rows[0].database, "affiliateos", "Drift simulation is restricted to the ephemeral affiliateos CI database.");

  const ledger = await client.query(
    "SELECT table_schema FROM information_schema.tables WHERE table_name = '__drizzle_migrations'"
  );
  assert.deepEqual(ledger.rows.map((row) => row.table_schema), ["drizzle"], "Expected exactly one Drizzle ledger in schema drizzle.");

  await client.query("BEGIN");
  try {
    // Recreate the audited production schema drift only inside the ephemeral CI DB.
    // Keep older historical ledger entries intact because their journal timestamps
    // are non-monotonic. Remove the forward-repair migration and any later migration
    // rows in this ephemeral test database, so Drizzle can reapply 0067 in timestamp
    // order before reapplying 0068. Also roll back schema effects of later migrations
    // whose ledger rows are removed, so their DDL can be exercised again safely.
    // Never run this simulation against production.
    await client.query("DROP TABLE IF EXISTS public.content_products");
    await client.query("ALTER TABLE public.publication_jobs DROP COLUMN IF EXISTS confirmed_at");
    await client.query("ALTER TABLE public.publication_jobs DROP COLUMN IF EXISTS tiktok_approval");
    await client.query("ALTER TABLE public.media_assets DROP COLUMN IF EXISTS duration_seconds");
    await client.query("ALTER TABLE public.media_assets DROP CONSTRAINT IF EXISTS media_assets_dimensions_positive_check");
    await client.query("ALTER TABLE public.media_assets DROP COLUMN IF EXISTS width_px");
    await client.query("ALTER TABLE public.media_assets DROP COLUMN IF EXISTS height_px");
    await client.query("ALTER TABLE public.media_assets DROP COLUMN IF EXISTS has_audio");
    await client.query(
      'DELETE FROM "drizzle"."__drizzle_migrations" WHERE created_at > $1',
      [1794050405007]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const check = await client.query(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='publication_jobs' AND column_name='confirmed_at') AS has_confirmed_at,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='publication_jobs' AND column_name='tiktok_approval') AS has_tiktok_approval,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='media_assets' AND column_name='duration_seconds') AS has_duration_seconds,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='media_assets' AND column_name='width_px') AS has_width_px,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='media_assets' AND column_name='height_px') AS has_height_px,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='media_assets' AND column_name='has_audio') AS has_has_audio,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conname='media_assets_dimensions_positive_check') AS has_dimensions_check,
      to_regclass('public.content_products') IS NOT NULL AS has_content_products
  `);
  assert.deepEqual(check.rows[0], {
    has_confirmed_at: false,
    has_tiktok_approval: false,
    has_duration_seconds: false,
    has_width_px: false,
    has_height_px: false,
    has_has_audio: false,
    has_dimensions_check: false,
    has_content_products: false
  });
  console.log("Simulated production migration drift in ephemeral CI database; historical ledger entries were not fabricated.");
} finally {
  await client.end();
}
