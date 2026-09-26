const required = [
  ["DATABASE_URL", value => /^(postgres|postgresql):\\/\\//.test(value)],
  ["API_AUTH_TOKEN", value => value.length >= 32],
  ["API_CORS_ORIGIN", value => /^https:\\/\\//.test(value)]
];

if (process.env.NODE_ENV !== "production") {
  console.error("Production preflight requires NODE_ENV=production.");
  process.exit(1);
}

const failures = [];
for (const [name, check] of required) {
  const value = process.env[name]?.trim();
  if (!value || !check(value)) failures.push(name);
}
if (failures.length > 0) {
  console.error(`Production preflight failed: ${failures.join(", ")}`);
  process.exit(1);
}

if (process.env.AUTONOMOUS_CYCLE_ENABLED === "true") {
  const interval = Number(process.env.AUTONOMOUS_CYCLE_INTERVAL_MS ?? "900000");
  if (!Number.isFinite(interval) || interval < 300000) {
    console.error("Production preflight failed: AUTONOMOUS_CYCLE_INTERVAL_MS must be at least 5 minutes.");
    process.exit(1);
  }

  const autonomousFailures = [];
  if (!isOpaqueCredentialReference(process.env.SHOPEE_AFFILIATE_CREDENTIAL_REFERENCE)) {
    autonomousFailures.push("SHOPEE_AFFILIATE_CREDENTIAL_REFERENCE");
  }
  if (!process.env.SHOPEE_AFFILIATE_APP_ID?.trim()) {
    autonomousFailures.push("SHOPEE_AFFILIATE_APP_ID");
  }
  if (!process.env.SHOPEE_AFFILIATE_APP_SECRET) {
    autonomousFailures.push("SHOPEE_AFFILIATE_APP_SECRET");
  }
  if (!process.env.SOCIAL_CREDENTIALS_JSON?.trim()) {
    autonomousFailures.push("SOCIAL_CREDENTIALS_JSON");
  }

  if (autonomousFailures.length > 0) {
    console.error(`Production preflight failed: autonomous activation requires ${autonomousFailures.join(", ")}.`);
    process.exit(1);
  }
}

console.log("Production configuration preflight passed.");

function isOpaqueCredentialReference(value) {
  const reference = value?.trim();
  if (!reference || /\\s/.test(reference)) return false;
  return /^(?:[a-z][a-z0-9+.-]*:\\/\\/|[A-Z][A-Z0-9_]*:)[A-Za-z0-9._\\/-]+$/i.test(reference);
}
