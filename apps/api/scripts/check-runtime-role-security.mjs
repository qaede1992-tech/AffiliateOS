import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Refusing to run the runtime-role security guard outside a GitHub Actions CI runner.");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");
const parsedUrl = new URL(connectionString);
if (!["localhost", "127.0.0.1", "::1", "postgres"].includes(parsedUrl.hostname)) {
  throw new Error("Refusing to inspect non-local database host: " + parsedUrl.hostname);
}

const client = new Client({ connectionString });
await client.connect();
try {
  const identity = await client.query("SELECT current_database() AS database, current_user AS role");
  assert.equal(identity.rows[0]?.database, "affiliateos");
  assert.equal(identity.rows[0]?.role, "affiliateos");

  const roleResult = await client.query(
    "SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolinherit, rolbypassrls " +
    "FROM pg_roles WHERE rolname = 'affiliateos_runtime'"
  );
  assert.equal(roleResult.rowCount, 1, "The runtime role must be created by migrations.");
  assert.deepEqual(roleResult.rows[0], {
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolcanlogin: false,
    rolinherit: false,
    rolbypassrls: false
  }, "The runtime role must be non-login until provisioned per environment, non-owner, non-superuser, and non-BYPASSRLS.");

  const tableResult = await client.query([
    "SELECT c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) AS owner,",
    "  has_table_privilege('affiliateos_runtime', c.oid, 'SELECT') AS can_select,",
    "  has_table_privilege('affiliateos_runtime', c.oid, 'INSERT') AS can_insert,",
    "  has_table_privilege('affiliateos_runtime', c.oid, 'UPDATE') AS can_update,",
    "  has_table_privilege('affiliateos_runtime', c.oid, 'DELETE') AS can_delete,",
    "  has_table_privilege('affiliateos_runtime', c.oid, 'TRUNCATE') AS can_truncate,",
    "  has_table_privilege('affiliateos_runtime', c.oid, 'TRIGGER') AS can_trigger,",
    "  EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public'",
    "    AND p.tablename = c.relname AND p.cmd = 'ALL'",
    "    AND 'affiliateos_runtime'::name = ANY(p.roles)",
    "    AND p.qual = 'true' AND p.with_check = 'true') AS has_runtime_policy",
    "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
    "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname"
  ].join("\n"));
  assert.ok(tableResult.rows.length > 0, "Expected application tables in public schema.");
  for (const table of tableResult.rows) {
    assert.equal(table.relrowsecurity, true, table.relname + " must have RLS enabled.");
    assert.notEqual(table.owner, "affiliateos_runtime", table.relname + " must not be owned by the runtime role.");
    assert.equal(table.can_select, true, table.relname + " must be readable by the runtime role.");
    assert.equal(table.can_insert, true, table.relname + " must be insertable by the runtime role.");
    assert.equal(table.can_update, true, table.relname + " must be updatable by the runtime role.");
    assert.equal(table.can_delete, true, table.relname + " must be deletable by the runtime role.");
    assert.equal(table.can_truncate, false, table.relname + " must not allow runtime TRUNCATE.");
    assert.equal(table.can_trigger, false, table.relname + " must not allow runtime TRIGGER privilege.");
    assert.equal(table.has_runtime_policy, true, table.relname + " must have the explicit runtime RLS policy.");
  }

  const schemaCreate = await client.query(
    "SELECT has_schema_privilege('affiliateos_runtime', 'public', 'CREATE') AS can_create"
  );
  assert.equal(schemaCreate.rows[0]?.can_create, false, "The runtime role must not create objects in public.");

  const defaults = await client.query([
    "SELECT d.defaclobjtype AS object_type, acl.privilege_type",
    "FROM pg_default_acl d",
    "CROSS JOIN LATERAL aclexplode(d.defaclacl) acl",
    "JOIN pg_roles grantee ON grantee.oid = acl.grantee",
    "WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)",
    "  AND d.defaclnamespace = 'public'::regnamespace",
    "  AND grantee.rolname = 'affiliateos_runtime'",
    "ORDER BY d.defaclobjtype, acl.privilege_type"
  ].join("\n"));
  const defaultPrivileges = new Set(defaults.rows.map((row) => row.object_type + ":" + row.privilege_type));
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    assert.ok(defaultPrivileges.has("r:" + privilege), "Future tables need runtime " + privilege + " by default.");
  }
  for (const privilege of ["USAGE", "SELECT", "UPDATE"]) {
    assert.ok(defaultPrivileges.has("S:" + privilege), "Future sequences need runtime " + privilege + " by default.");
  }

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE affiliateos_runtime");
    const id = randomUUID();
    const inserted = await client.query(
      "INSERT INTO public.affiliates (id, name, email, status, created_at) " +
      "VALUES ($1, $2, $3, $4, now()) RETURNING id",
      [id, "CI runtime role fixture", "ci-runtime-" + id + "@example.invalid", "active"]
    );
    assert.equal(inserted.rowCount, 1, "Runtime role must be able to insert through RLS.");
    const updated = await client.query(
      "UPDATE public.affiliates SET status = 'inactive' WHERE id = $1 RETURNING id",
      [id]
    );
    assert.equal(updated.rowCount, 1, "Runtime role must be able to update through RLS.");
    const deleted = await client.query("DELETE FROM public.affiliates WHERE id = $1 RETURNING id", [id]);
    assert.equal(deleted.rowCount, 1, "Runtime role must be able to delete through RLS.");
  } finally {
    await client.query("ROLLBACK");
  }

  console.log("Runtime-role security guard passed: RLS and explicit policies cover all public tables; runtime has DML but no DDL, TRUNCATE, TRIGGER, or BYPASSRLS.");
} finally {
  await client.end();
}
