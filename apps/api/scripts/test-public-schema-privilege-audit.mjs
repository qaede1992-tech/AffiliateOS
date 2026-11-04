import assert from "node:assert/strict";
import { Client } from "pg";
import { findPublicSchemaDefaultAclGrants } from "./public-schema-privilege-audit.mjs";

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

  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'");
  assert.equal(existing.rowCount, 0, "The isolated CI database must not contain a pre-existing supabase_admin role.");

  await client.query("BEGIN");
  transactionStarted = true;
  await client.query("CREATE ROLE supabase_admin NOLOGIN");
  await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin GRANT SELECT ON TABLES TO authenticated");
  await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon");
  await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO authenticated");
  await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC");

  const { rows: aclRows } = await client.query(`
    SELECT COALESCE(n.nspname, '<global>') AS schema_name,
           owner.rolname AS creator_role,
           d.defaclobjtype AS object_type,
           COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
           acl.privilege_type
    FROM pg_default_acl d
    JOIN pg_roles owner ON owner.oid = d.defaclrole
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE d.defaclnamespace = 0 OR n.nspname = 'public'
    ORDER BY schema_name, creator_role, object_type, grantee, acl.privilege_type
  `);
  const findings = findPublicSchemaDefaultAclGrants(aclRows);
  const keys = new Set(findings.map((finding) =>
    `${finding.schemaName}:${finding.creatorRole}:${finding.objectType}:${finding.grantee}`
  ));

  assert.ok(keys.has("<global>:supabase_admin:r:authenticated"), "The audit must detect global defaults created by supabase_admin.");
  assert.ok(keys.has("public:supabase_admin:r:anon"), "The audit must detect schema-specific table defaults created by supabase_admin.");
  assert.ok(keys.has("public:supabase_admin:S:authenticated"), "The audit must detect schema-specific sequence defaults created by supabase_admin.");
  assert.ok(keys.has("public:supabase_admin:f:PUBLIC"), "The audit must detect schema-specific function defaults granted to PUBLIC.");

  console.log("Supabase-managed default ACL fixture passed: global and public-schema grants from supabase_admin were detected.");
} finally {
  if (transactionStarted) await client.query("ROLLBACK");
  await client.end();
}
