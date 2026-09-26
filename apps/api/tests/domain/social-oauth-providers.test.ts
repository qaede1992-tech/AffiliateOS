import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TikTokOAuthProvider } from "../../src/domain/tiktok-oauth-provider.js";
import { InstagramOAuthProvider } from "../../src/domain/instagram-oauth-provider.js";

const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

describe("official social OAuth providers", () => {
  it("builds the current TikTok v2 authorization URL with publishing scope", () => {
    const provider = new TikTokOAuthProvider({ clientKey: "client-key", clientSecret: "client-secret" });
    const url = new URL(provider.createAuthorizationUrl({ state: "state-1", redirectUri: "https://app.example/callback" }));
    assert.equal(url.origin, "https://www.tiktok.com");
    assert.equal(url.pathname, "/v2/auth/authorize/");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("scope"), "user.info.basic,video.publish");
  });

  it("exchanges TikTok authorization codes without persisting token material in the account record", async () => {
    const provider = new TikTokOAuthProvider({
      clientKey: "client-key",
      clientSecret: "client-secret",
      fetchImpl: async (_input, init) => {
        assert.equal(init?.method, "POST");
        assert.equal(init?.headers && new Headers(init.headers).get("content-type"), "application/x-www-form-urlencoded");
        return response({ access_token: "token-never-persisted", open_id: "open-123", scope: "user.info.basic,video.publish", expires_in: 86400 });
      }
    });
    const result = await provider.exchangeCode({ code: "code", redirectUri: "https://app.example/callback" });
    assert.equal(result.accountReference, "open-123");
    assert.equal(result.credentialReference, "secret://affiliateos/social/tiktok/open-123");
    assert.equal(JSON.stringify(result).includes("token-never-persisted"), false);
  });

  it("builds the current Instagram Login authorization URL with publishing scope", () => {
    const provider = new InstagramOAuthProvider({ clientId: "client-id", clientSecret: "client-secret" });
    const url = new URL(provider.createAuthorizationUrl({ state: "state-1", redirectUri: "https://app.example/callback" }));
    assert.equal(url.origin, "https://www.instagram.com");
    assert.equal(url.pathname, "/oauth/authorize");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("scope"), "instagram_business_basic,instagram_business_content_publish");
  });

  it("exchanges Instagram authorization codes into an opaque credential reference", async () => {
    const provider = new InstagramOAuthProvider({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetchImpl: async () => response({ access_token: "token-never-persisted", user_id: "ig-123" })
    });
    const result = await provider.exchangeCode({ code: "code", redirectUri: "https://app.example/callback" });
    assert.equal(result.accountReference, "ig-123");
    assert.equal(result.credentialReference, "secret://affiliateos/social/instagram/ig-123");
    assert.equal(JSON.stringify(result).includes("token-never-persisted"), false);
  });
});
