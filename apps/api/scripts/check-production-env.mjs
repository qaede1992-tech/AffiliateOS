const required = [
  ["DATABASE_URL", value => /^(postgres|postgresql):\/\//.test(value)],
  ["API_AUTH_TOKEN", value => value.length >= 32],
  ["API_CORS_ORIGIN", value => /^https:\/\//.test(value)]
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

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL?.trim();
if (migrationDatabaseUrl) {
  let runtimeIdentity;
  let migrationIdentity;
  try {
    const runtimeUrl = new URL(process.env.DATABASE_URL ?? "");
    const migrationUrl = new URL(migrationDatabaseUrl);
    if (!["postgres:", "postgresql:"].includes(migrationUrl.protocol)) {
      throw new Error("invalid protocol");
    }
    runtimeIdentity = runtimeUrl.protocol + "//" + runtimeUrl.hostname + ":" +
      (runtimeUrl.port || "5432") + runtimeUrl.pathname + ":" + decodeURIComponent(runtimeUrl.username);
    migrationIdentity = migrationUrl.protocol + "//" + migrationUrl.hostname + ":" +
      (migrationUrl.port || "5432") + migrationUrl.pathname + ":" + decodeURIComponent(migrationUrl.username);
  } catch {
    failures.push("MIGRATION_DATABASE_URL(valid PostgreSQL URL)");
  }
  if (runtimeIdentity && migrationIdentity && runtimeIdentity === migrationIdentity) {
    failures.push("MIGRATION_DATABASE_URL(different database role from DATABASE_URL)");
  }
}

if (failures.length > 0) {
  console.error("Production preflight failed: " + failures.join(", "));
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
  const socialCredentialsJson = process.env.SOCIAL_CREDENTIALS_JSON?.trim();
  const socialCredentialStoreKey = process.env.SOCIAL_CREDENTIAL_STORE_KEY?.trim();
  if (socialCredentialStoreKey) {
    if (socialCredentialStoreKey.length < 32) autonomousFailures.push("SOCIAL_CREDENTIAL_STORE_KEY");
  } else if (!socialCredentialsJson) {
    autonomousFailures.push("SOCIAL_CREDENTIALS_JSON or SOCIAL_CREDENTIAL_STORE_KEY");
  } else if (!isJsonObject(socialCredentialsJson)) {
    autonomousFailures.push("SOCIAL_CREDENTIALS_JSON(valid JSON object)");
  }

  if (autonomousFailures.length > 0) {
    console.error("Production configuration preflight failed: autonomous activation requires " + autonomousFailures.join(", ") + ".");
    process.exit(1);
  }
}

console.log("Production configuration preflight passed.");

function isJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed) &&
      Object.keys(parsed).length > 0 &&
      Object.entries(parsed).every(([key, credential]) => key.trim() && isConfiguredCredential(credential));
  } catch {
    return false;
  }
}

function isConfiguredCredential(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return typeof value.accessToken === "string" && value.accessToken.trim().length > 0;
}

function isOpaqueCredentialReference(value) {
  const reference = value?.trim();
  if (!reference || /\s/.test(reference)) return false;
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|[A-Z][A-Z0-9_]*:)[A-Za-z0-9._\/-]+$/i.test(reference);
}
