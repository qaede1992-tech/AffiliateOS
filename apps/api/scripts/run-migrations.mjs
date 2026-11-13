import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { assertMigrationRole } from "./migration-runner-preflight.mjs";

const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationUrl) {
  throw new Error("MIGRATION_DATABASE_URL is required; refusing to run migrations with the application runtime role.");
}

const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
const verificationEnv = { ...process.env, DATABASE_URL: migrationUrl };

function runVerification(scriptName) {
  const result = spawnSync(process.execPath, [`scripts/${scriptName}`], {
    cwd: apiDirectory,
    env: verificationEnv,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${scriptName} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

const pool = new Pool({ connectionString: migrationUrl, max: 1, connectionTimeoutMillis: 10000 });
try {
  const { rows: roleRows } = await pool.query(`
    SELECT
      current_user AS "roleName",
      migration_role.rolsuper AS "roleIsSuperuser",
      migration_role.rolbypassrls AS "roleBypassRls",
      pg_get_userbyid(ledger.relowner) AS "ledgerOwner",
      pg_has_role(current_user, ledger.relowner, 'USAGE') AS "hasOwnerPrivileges",
      ledger.relforcerowsecurity AS "ledgerForceRls"
    FROM pg_roles AS migration_role
    JOIN pg_class AS ledger ON ledger.relname = '__drizzle_migrations'
    JOIN pg_namespace AS ledger_schema ON ledger_schema.oid = ledger.relnamespace
    WHERE migration_role.rolname = current_user
      AND ledger_schema.nspname = 'drizzle'
      AND ledger.relkind = 'r'
  `);
  if (roleRows.length !== 1) {
    throw new Error("Expected exactly one private Drizzle migration ledger; refusing to run migrations.");
  }
  assertMigrationRole(roleRows[0]);

  runVerification("verify-migrations-preflight.mjs");
  await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../drizzle/", import.meta.url)) });
} finally {
  await pool.end();
}

runVerification("verify-migrations.mjs");
console.log("Drizzle migrations applied and verified successfully.");
