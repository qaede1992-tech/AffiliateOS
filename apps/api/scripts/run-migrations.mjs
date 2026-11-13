import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

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

runVerification("verify-migrations-preflight.mjs");

const pool = new Pool({ connectionString: migrationUrl, max: 1, connectionTimeoutMillis: 10000 });
try {
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
} finally {
  await pool.end();
}

runVerification("verify-migrations.mjs");
console.log("Drizzle migrations applied and verified successfully.");
