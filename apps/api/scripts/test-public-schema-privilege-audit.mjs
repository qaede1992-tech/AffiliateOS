import assert from "node:assert/strict";
import { Client } from "pg";
import {
  findPublicSchemaDefaultAclGrants,
  PUBLIC_SCHEMA_DEFAULT_ACL_QUERY
} from "./public-schema-privilege-audit.mjs";

if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Refusing to create Supabase ACL fixtures outside a GitHub Actions CI runner.");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");

const parsedUrl = new URL(connectionString);
if (!["localhost", "127.0.0.1", "::1", "postgres"].includes(parsedUrl.hostname)) {
  throw new Error(`Refusing to mutate non-local database host: ${parsedUrl.hostname}`);
}

const client = new Client({ connectionString });
await client.connect();
let transactionStarted = false;
try {
  const { rows } = await client.query(`
    SELECT current_database() AS database,
           current_user AS role,
           current_setting('is_superuser') AS is_superuser
  `);
  assert.equal(rows[0]?.database, "affiliateos", "ACL fixtures are restricted to the ephemeral affiliateos CI database.");
  assert.equal(rows[0]?.role, "affiliateos", "ACL fixtures must use the dedicated CI database role.");
  assert.equal(rows[0]?.is_superuser, "on", "ACL fixtures require the ephemeral CI superuser.");

  const existing = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = ANY($1::text[])",
    [["supabase_admin", "affiliateos_implicit_function_creator"]]
  );
  assert.equal(existing.rowCount, 0, "The isolated CI database must not contain pre-existing ACL fixture roles.");

  await client.query("BEGIN");
  transactionStarted = true;
  await client.query("CREATE ROLE supabase_admin NOLOGIN");
  await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin GRANT SELECT ON TABLES TO authenticated");
  await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon");
  await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO authenticated");
  await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC");

  // This creator has no pg_default_acl function override. PostgreSQL's built-in
  // acldefault('f', ...) still grants EXECUTE to PUBLIC for newly created functions.
  await client.query("CREATE ROLE affiliateos_implicit_function_creator NOLOGIN");
  await client.query("GRANT USAGE, CREATE ON SCHEMA public TO affiliateos_implicit_function_creator");
  await client.query("SET ROLE affiliateos_implicit_function_creator");
  await client.query(`
    CREATE FUNCTION public.affiliateos_acl_implicit_execute_probe()
    RETURNS integer
    LANGUAGE sql
    IMMUTABLE
    AS 'SELECT 1'
  `);
  await client.query("RESET ROLE");

  const { rows: probeRows } = await client.query(`
    SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'affiliateos_acl_implicit_execute_probe'
  `);
  assert.deepEqual(probeRows, [{ anon_can_execute: true, authenticated_can_execute: true }]);

  const { rows: aclRows } = await client.query(PUBLIC_SCHEMA_DEFAULT_ACL_QUERY);
  const findings = findPublicSchemaDefaultAclGrants(aclRows);
  const keys = new Set(findings.map((finding) =>
    `${finding.schemaName}:${finding.creatorRole}:${finding.objectType}:${finding.grantee}`
  ));

  assert.ok(keys.has("<global>:supabase_admin:r:authenticated"), "The audit must detect global defaults created by supabase_admin.");
  assert.ok(keys.has("public:supabase_admin:r:anon"), "The audit must detect schema-specific table defaults created by supabase_admin.");
  assert.ok(keys.has("public:supabase_admin:S:authenticated"), "The audit must detect schema-specific sequence defaults created by supabase_admin.");
  assert.ok(keys.has("public:supabase_admin:f:PUBLIC"), "The audit must detect explicit schema-specific function defaults granted to PUBLIC.");
  assert.ok(
    keys.has("<global>:affiliateos_implicit_function_creator:f:PUBLIC"),
    "The audit must detect PostgreSQL's implicit PUBLIC EXECUTE default when no global function override exists."
  );

  console.log("Supabase default ACL fixtures passed: managed-role grants and implicit PUBLIC function EXECUTE were detected.");
} finally {
  if (transactionStarted) await client.query("ROLLBACK");
  await client.end();
}
