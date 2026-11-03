import assert from "node:assert/strict";
import { Client } from "pg";

if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Refusing to create privilege-test roles outside a GitHub Actions CI runner.");
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
  const { rows } = await client.query(
    `SELECT current_database() AS database, current_user AS role, r.rolsuper AS is_superuser
       FROM pg_roles r WHERE r.rolname = current_user`
  );
  assert.equal(rows[0]?.database, "affiliateos", "Privilege fixtures are restricted to the ephemeral affiliateos CI database.");
  assert.equal(rows[0]?.role, "affiliateos", "Privilege fixtures must use the dedicated CI database role.");
  assert.equal(rows[0]?.is_superuser, true, "The ephemeral CI database role must be able to create no-login test roles.");

  for (const role of ["anon", "authenticated"]) {
    const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
    }
  }

  // The production policy under test explicitly revokes PostgreSQL's built-in
  // PUBLIC EXECUTE default for roles that can create functions in public.
  // Mirror that safe baseline in the disposable CI database; the separate
  // ACL fixture proves the guard still detects an unconfigured creator role.
  await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE affiliateos REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
  await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE pg_database_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");

  console.log("Created isolated anon/authenticated roles and configured the CI-only safe function default ACL baseline.");
} finally {
  await client.end();
}
