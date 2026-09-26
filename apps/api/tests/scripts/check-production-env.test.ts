import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/check-production-env.mjs");

function runPreflight(overrides: Record<string, string | undefined>) {
  const env = { ...process.env, ...overrides };
  return spawnSync(process.execPath, [script], { env, encoding: "utf8" });
}

const baseEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://release:release@127.0.0.1:5432/release",
  API_AUTH_TOKEN: "12345678901234567890123456789012",
  API_CORS_ORIGIN: "https://dashboard.example.com",
  AUTONOMOUS_CYCLE_ENABLED: "false"
};

test("production preflight keeps autonomous mode opt-in", () => {
  const result = runPreflight(baseEnvironment);
  assert.equal(result.status, 0, result.stderr);
});

test("production preflight rejects autonomous mode without provider readiness", () => {
  const result = runPreflight({
    ...baseEnvironment,
    AUTONOMOUS_CYCLE_ENABLED: "true"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHOPEE_AFFILIATE_CREDENTIAL_REFERENCE/);
  assert.match(result.stderr, /SOCIAL_CREDENTIALS_JSON/);
});

test("production preflight accepts autonomous mode with opaque references and runtime credentials", () => {
  const result = runPreflight({
    ...baseEnvironment,
    AUTONOMOUS_CYCLE_ENABLED: "true",
    AUTONOMOUS_CYCLE_INTERVAL_MS: "900000",
    SHOPEE_AFFILIATE_CREDENTIAL_REFERENCE: "vault://affiliateos/shopee",
    SHOPEE_AFFILIATE_APP_ID: "production-app-id",
    SHOPEE_AFFILIATE_APP_SECRET: "runtime-secret",
    SOCIAL_CREDENTIALS_JSON: "{\"instagram\":\"secret-manager-reference\"}"
  });
  assert.equal(result.status, 0, result.stderr);
});
