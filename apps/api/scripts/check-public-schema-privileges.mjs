import assert from "node:assert/strict";
import { Client } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");

const client = new Client({ connectionString });
await client.connect();
try {
  const { rows: identityRows } = await client.query(
    "SELECT current_database() AS database, current_user AS role"
  );
  assert.equal(identityRows[0]?.database, "affiliateos", "Privilege verification is restricted to the ephemeral affiliateos CI database.");

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
    SELECT owner.rolname AS creator_role, d.defaclobjtype AS object_type,
           grantee.rolname AS grantee, acl.privilege_type
    FROM pg_default_acl d
    JOIN pg_roles owner ON owner.oid = d.defaclrole
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
    JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE n.nspname = 'public'
      AND owner.rolname = current_user
      AND grantee.rolname IN ('anon', 'authenticated')
    ORDER BY d.defaclobjtype, grantee.rolname, acl.privilege_type
  `);

  assert.deepEqual(tableRows, [], "anon/authenticated must not have effective privileges on public tables or views.");
  assert.deepEqual(sequenceRows, [], "anon/authenticated must not have effective privileges on public sequences.");
  assert.deepEqual(routineRows, [], "anon/authenticated must not have effective EXECUTE privileges on public routines.");
  assert.deepEqual(defaultAclRows, [], "The application migration role must not configure default public-schema privileges for anon/authenticated.");

  console.log("Public-schema privilege guard passed: no effective table, sequence, routine, or application-role default ACL privileges for anon/authenticated.");
} finally {
  await client.end();
}
