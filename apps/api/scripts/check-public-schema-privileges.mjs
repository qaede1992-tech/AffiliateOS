import assert from "node:assert/strict";
import { Client } from "pg";
import { findPublicSchemaDefaultAclGrants } from "./public-schema-privilege-audit.mjs";

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
  const { rows: defaultAclRows } = await client.query(`
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

    UNION ALL

    -- pg_default_acl stores only overrides. PostgreSQL's built-in function
    -- default (EXECUTE TO PUBLIC) must be evaluated for creators with no
    -- global function override, then combined with schema-specific additions.
    SELECT 'public' AS schema_name,
           owner.rolname AS creator_role,
           'f' AS object_type,
           COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
           acl.privilege_type
    FROM pg_roles owner
    LEFT JOIN pg_default_acl global_function_acl
      ON global_function_acl.defaclrole = owner.oid
     AND global_function_acl.defaclnamespace = 0
     AND global_function_acl.defaclobjtype = 'f'
    LEFT JOIN pg_default_acl public_function_acl
      ON public_function_acl.defaclrole = owner.oid
     AND public_function_acl.defaclnamespace = 'public'::regnamespace
     AND public_function_acl.defaclobjtype = 'f'
    CROSS JOIN LATERAL aclexplode(
      COALESCE(global_function_acl.defaclacl, acldefault('f', owner.oid))
      || COALESCE(public_function_acl.defaclacl, '{}'::aclitem[])
    ) AS acl
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE has_schema_privilege(owner.oid, 'public', 'CREATE')
      AND acl.privilege_type = 'EXECUTE'
      AND (acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated'))
    ORDER BY schema_name, creator_role, object_type, grantee, privilege_type
  `);
  const broadDefaultAclRows = findPublicSchemaDefaultAclGrants(defaultAclRows);

  assert.deepEqual(tableRows, [], "anon/authenticated must not have effective privileges on public tables or views.");
  assert.deepEqual(sequenceRows, [], "anon/authenticated must not have effective privileges on public sequences.");
  assert.deepEqual(routineRows, [], "anon/authenticated must not have effective EXECUTE privileges on public routines.");
  assert.deepEqual(
    broadDefaultAclRows,
    [],
    "No creator role or global default may grant public-schema privileges to anon, authenticated, or PUBLIC."
  );

  console.log("Public-schema privilege guard passed: no effective table, sequence, routine, or broad public-schema default ACL privileges.");
} finally {
  await client.end();
}
