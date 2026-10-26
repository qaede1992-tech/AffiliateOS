import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const preflightScript = resolve(import.meta.dirname, "../scripts/check-production-env.mjs");
const runtimeUrl = "postgresql://affiliateos_runtime:runtime-secret@db.example.com:5432/postgres";
const migrationUrl = "postgresql://affiliateos_migrator:migration-secret@db.example.com:5432/postgres";

function runPreflight(migrationDatabaseUrl?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: runtimeUrl,
    API_AUTH_TOKEN: "production-test-token-12345678901234567890",
    API_CORS_ORIGIN: "https://affiliateos.example.com",
    AUTONOMOUS_CYCLE_ENABLED: "false"
  };
  if (migrationDatabaseUrl === undefined) delete env.MIGRATION_DATABASE_URL;
  else env.MIGRATION_DATABASE_URL = migrationDatabaseUrl;
  return spawnSync(process.execPath, [preflightScript], { env, encoding: "utf8" });
}

test("production preflight preserves compatibility when migration URL is unset", () => {
  const result = runPreflight();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /preflight passed/i);
});

test("production preflight accepts a separate migration role", () => {
  const result = runPreflight(migrationUrl);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /preflight passed/i);
});

test("production preflight rejects a migration URL using the runtime role", () => {
  const sameRoleUrl = "postgres://affiliateos_runtime:other-secret@db.example.com:5432/postgres";
  const result = runPreflight(sameRoleUrl);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different database role/i);
  assert.doesNotMatch(result.stderr + result.stdout, /runtime-secret|other-secret/);
});

test("production preflight rejects a non-PostgreSQL migration URL", () => {
  const result = runPreflight("https://db.example.com/postgres");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /valid PostgreSQL URL/i);
});
