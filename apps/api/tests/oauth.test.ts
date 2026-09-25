import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySocialAccountRepository } from "../src/domain/repository.js";
import { InMemoryOAuthStateRepository, InMemorySocialOAuthProviderRegistry, SocialOAuthService, type OAuthStateRepository, type SocialOAuthProvider } from "../src/domain/oauth.js";

const provider: SocialOAuthProvider = { platform: "instagram", authorizationEndpoint: "https://provider.invalid/oauth/authorize", createAuthorizationUrl: ({ state, redirectUri }) => `https://provider.invalid/oauth/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`, exchangeCode: async ({ code, redirectUri }) => ({ accountReference: `acct-${code}`, credentialReference: "vault://affiliateos/social/instagram/acct", connection: { redirectUri, accessToken: "oauth-secret", refreshToken: "refresh-secret", nested: { clientSecret: "client-secret" } } }) };
const rawCredentialProvider: SocialOAuthProvider = { ...provider, exchangeCode: async ({ code, redirectUri }) => ({ accountReference: `acct-${code}`, credentialReference: "raw-access-token", connection: { redirectUri } }) };
function createService(ttl = 600_000, states: OAuthStateRepository = new InMemoryOAuthStateRepository()) { const registry = new InMemorySocialOAuthProviderRegistry(); registry.register(provider); return new SocialOAuthService(registry, new InMemorySocialAccountRepository(), states, ttl); }

test("OAuth start creates a state-bound authorization URL", async () => { const oauthService = createService(); const result = await oauthService.start("instagram", "https://app.example.com/oauth/callback"); assert.match(result.authorizationUrl, /state=/); assert.match(result.authorizationUrl, /redirect_uri=/); assert.equal(result.state.length > 0, true); });
test("OAuth start rejects unsafe redirect URI schemes", async () => { const oauthService = createService(); await assert.rejects(() => oauthService.start("instagram", "javascript:alert(1)"), /redirect URI is not allowed/i); await assert.rejects(() => oauthService.start("instagram", "http://attacker.example.com/callback"), /redirect URI is not allowed/i); });
test("OAuth callback consumes state once and redacts credentials", async () => { const oauthService = createService(); const started = await oauthService.start("instagram", "https://app.example.com/oauth/callback"); const account = await oauthService.callback("instagram", "user-42", started.state); assert.equal(account.accountReference, "acct-user-42"); assert.equal(account.hasCredentialReference, true); assert.equal("credentialReference" in account, false); assert.equal(account.connection.accessToken, "[REDACTED]"); assert.equal(account.connection.refreshToken, "[REDACTED]"); assert.deepEqual(account.connection.nested, { clientSecret: "[REDACTED]" }); await assert.rejects(() => oauthService.callback("instagram", "user-42", started.state), /state is invalid/i); });
test("OAuth state survives service reconstruction when backed by a shared store", async () => { const states = new InMemoryOAuthStateRepository(); const first = createService(600_000, states); const started = await first.start("instagram", "https://app.example.com/oauth/callback"); const second = createService(600_000, states); const account = await second.callback("instagram", "user-99", started.state); assert.equal(account.accountReference, "acct-user-99"); });
test("OAuth callback preserves state on a mismatched platform and consumes it only on a valid callback", async () => { const oauthService = createService(); const started = await oauthService.start("instagram", "https://app.example.com/oauth/callback"); await assert.rejects(() => oauthService.callback("facebook", "user-42", started.state), /state is invalid/i); const account = await oauthService.callback("instagram", "user-42", started.state); assert.equal(account.accountReference, "acct-user-42"); });
test("OAuth callback rejects expired state", async () => { const oauthService = createService(1); const started = await oauthService.start("instagram", "https://app.example.com/oauth/callback"); await new Promise((resolve) => setTimeout(resolve, 5)); await assert.rejects(() => oauthService.callback("instagram", "user-42", started.state), /state has expired/i); });
test("OAuth start prunes expired states before creating a new state", async () => { const states = new InMemoryOAuthStateRepository(); await states.save({ state: "expired-state", platform: "instagram", redirectUri: "https://app.example.com/oauth/callback", expiresAt: new Date(Date.now() - 1_000).toISOString() }); const oauthService = createService(600_000, states); await oauthService.start("instagram", "https://app.example.com/oauth/callback"); await assert.rejects(() => oauthService.callback("instagram", "user-42", "expired-state"), /state is invalid/i); });
test("OAuth start rejects platforms without a configured provider", async () => { const oauthService = createService(); await assert.rejects(() => oauthService.start("tiktok", "https://app.example.com/oauth/callback"), /OAuth is not configured/i); });

test("OAuth callback recovers from a concurrent social-account insert", async () => {
  const registry = new InMemorySocialOAuthProviderRegistry();
  registry.register(provider);
  const existing = { id: "raced-account", platform: "instagram", accountReference: "acct-raced", status: "active" as const, connection: {}, credentialReference: "vault://old", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let firstLookup = true;
  let firstSave = true;
  const accounts = {
    async list() { return [existing]; },
    async findById(id: string) { return id === existing.id ? existing : undefined; },
    async save(account: typeof existing) { if (firstSave) { firstSave = false; throw Object.assign(new Error("duplicate key"), { code: "23505" }); } return account; },
    async findByPlatformAccount(platform: string, accountReference: string) { if (firstLookup) { firstLookup = false; return undefined; } return platform === existing.platform && accountReference === existing.accountReference ? existing : undefined; }
  };
  const oauthService = new SocialOAuthService(registry, accounts, new InMemoryOAuthStateRepository());
  const started = await oauthService.start("instagram", "https://app.example.com/oauth/callback");
  const account = await oauthService.callback("instagram", "raced", started.state);
  assert.equal(account.id, existing.id);
  assert.equal(account.accountReference, existing.accountReference);
  assert.equal(account.hasCredentialReference, true);
});


test("OAuth callback rejects raw credential values from a provider", async () => {
  const registry = new InMemorySocialOAuthProviderRegistry();
  registry.register(rawCredentialProvider);
  const oauthService = new SocialOAuthService(registry, new InMemorySocialAccountRepository());
  const started = await oauthService.start("instagram", "https://app.example.com/oauth/callback");
  await assert.rejects(() => oauthService.callback("instagram", "raw", started.state), /Social credential references must be opaque secret-manager references/i);
});
