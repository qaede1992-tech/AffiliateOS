import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySocialAccountRepository } from "../src/domain/repository.js";
import { InMemorySocialOAuthProviderRegistry, SocialOAuthService, type SocialOAuthProvider } from "../src/domain/oauth.js";

const provider: SocialOAuthProvider = {
  platform: "instagram",
  authorizationEndpoint: "https://provider.invalid/oauth/authorize",
  createAuthorizationUrl: ({ state, redirectUri }) => `https://provider.invalid/oauth/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  exchangeCode: async ({ code, redirectUri }) => ({ accountReference: `acct-${code}`, credentialReference: "vault://affiliateos/social/instagram/acct", connection: { redirectUri } })
};

function service(ttl = 600_000) {
  const registry = new InMemorySocialOAuthProviderRegistry();
  registry.register(provider);
  return { service: new SocialOAuthService(registry, new InMemorySocialAccountRepository(), ttl), registry };
}

test("OAuth start creates a state-bound authorization URL", () => {
  const { service } = service();
  const result = service.start("instagram", "https://app.example.com/oauth/callback");
  assert.match(result.authorizationUrl, /state=/);
  assert.match(result.authorizationUrl, /redirect_uri=/);
  assert.equal(result.state.length > 0, true);
});

test("OAuth callback consumes state once and redacts credentials", async () => {
  const { service } = service();
  const started = service.start("instagram", "https://app.example.com/oauth/callback");
  const account = await service.callback("instagram", "user-42", started.state);
  assert.equal(account.accountReference, "acct-user-42");
  assert.equal(account.hasCredentialReference, true);
  assert.equal("credentialReference" in account, false);
  await assert.rejects(() => service.callback("instagram", "user-42", started.state), /state is invalid/i);
});

test("OAuth callback rejects mismatched platform and expired state", async () => {
  const { service } = service(1);
  const started = service.start("instagram", "https://app.example.com/oauth/callback");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(() => service.callback("facebook", "user-42", started.state), /state is invalid/i);
  await assert.rejects(() => service.callback("instagram", "user-42", started.state), /state has expired/i);
});

test("OAuth start rejects platforms without a configured provider", () => {
  const { service } = service();
  assert.throws(() => service.start("tiktok", "https://app.example.com/oauth/callback"), /OAuth is not configured/i);
});
