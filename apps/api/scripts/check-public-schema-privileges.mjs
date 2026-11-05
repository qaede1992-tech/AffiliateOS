import assert from "node:assert/strict";
import { Client } from "pg";
import {
  findPublicSchemaDefaultAclGrants,
  PUBLIC_SCHEMA_DEFAULT_ACL_QUERY
} from "./public-schema-privilege-audit.mjs";

if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Refusing to run the public-schema privilege guard outside a GitHub Actions CI runner.");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");

const parsedUrl = new URL(connectionString);
if (!["localhost", "127.0.0.1", "::1", "postgres"].includes(parsedUrl.hostname)) {
  throw new Error(`Refusing to inspect non-local database host: ${parsedUrl.hostname}`);
}

const client = new Client({ connectionString });
await client.connect();
try {
  const { rows: identityRows } = await client.query(
    "SELECT current_database() AS database, current_user AS role"
  );
  assert.equal(identityRows[0]?.database, "affiliateos", "Privilege verification is restricted to the ephemeral affiliateos CI database.");
  assert.equal(identityRows[0]?.role, "affiliateos", "Privilege verification must use the dedicated CI database role.");

  const { rows: roleRows } = await client.query(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname",
    [["anon", "authenticated"]]
  );
  assert.deepEqual(roleRows.map((row) => row.rolname), ["anon", "authenticated"], "Both test roles must exist; refusing to silently skip privilege verification.");

  const { rows: tableRows } = await client.query(`
    SELECT c.relname AS object_name, r.rolname AS grantee, p.privilege
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(privilege)
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_table_privilege(r.rolname::name, c.oid, p.privilege)
    ORDER BY c.relname, r.rolname, p.privilege
  `);
  const { rows: sequenceRows } = await client.query(`
    SELECT c.relname AS object_name, r.rolname AS grantee, p.privilege
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
    CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS p(privilege)
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
      AND has_sequence_privilege(r.rolname::name, c.oid, p.privilege)
    ORDER BY c.relname, r.rolname, p.privilege
  `);
  const { rows: routineRows } = await client.query(`
    SELECT p.proname AS object_name, r.rolname AS grantee
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
    WHERE n.nspname = 'public'
      AND has_function_privilege(r.rolname::name, p.oid, 'EXECUTE')
    ORDER BY p.proname, r.rolname
  `);
  const { rows: defaultAclRows } = await client.query(PUBLIC_SCHEMA_DEFAULT_ACL_QUERY);
  const broadDefaultAclRows = findPublicSchemaDefaultAclGrants(defaultAclRows);

  assert.deepEqual(tableRows, [], "anon/authenticated must not have effective privileges on public tables or views.");
  assert.deepEqual(sequenceRows, [], "anon/authenticated must not have effective privileges on public sequences.");
  assert.deepEqual(routineRows, [], "anon/authenticated must not have effective EXECUTE privileges on public routines.");
  assert.deepEqual(
    broadDefaultAclRows,
    [],
    "No creator role or global default may grant public-schema privileges to anon, authenticated, or PUBLIC."
  );

  console.log("Public-schema privilege guard passed: no effective object privileges or broad explicit/implicit defaults.");
} finally {
  await client.end();
}
