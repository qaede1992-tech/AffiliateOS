import type { SocialOAuthProvider } from "./oauth.js";

type InstagramTokenResponse = {
 access_token?: string;
 user_id?: string;
 permissions?: string;
 error_type?: string;
 error_message?: string;
};

export type InstagramOAuthConfiguration = {
 clientId: string;
 clientSecret: string;
 scopes?: string[];
 fetchImpl?: typeof fetch;
};

export class InstagramOAuthProvider implements SocialOAuthProvider {
  readonly platform = "instagram";
  readonly authorizationEndpoint = "https://www.instagram.com/oauth/authorize";

  private readonly fetchImpl: typeof fetch;
  private readonly scopes: string[];

  constructor(private readonly configuration: InstagramOAuthConfiguration) {
    this.fetchImpl = configuration.fetchImpl ?? fetch;
    this.scopes = configuration.scopes ?? ["instagram_business_basic", "instagram_business_content_publish"];
    if (!configuration.clientId.trim() || !configuration.clientSecret.trim()) {
      throw new Error("Instagram OAuth client credentials are required.");
    }
    if (!this.scopes.includes("instagram_business_content_publish")) {
      throw new Error("Instagram publishing requires the instagram_business_content_publish scope.");
    }
  }

  createAuthorizationUrl(input: { state: string; redirectUri: string }): string {
    const url = new URL(this.authorizationEndpoint);
    url.searchParams.set("client_id", this.configuration.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.scopes.join(","));
    url.searchParams.set("state", input.state);
    return url.toString();
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<{ accountReference: string; credentialReference: string; connection?: Record<string, unknown> }> {
    const body = new URLSearchParams({
      client_id: this.configuration.clientId,
      client_secret: this.configuration.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
      code: input.code
    });
    const response = await this.fetchImpl("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    const payload = await readJson<InstagramTokenResponse>(response);
    if (!response.ok || !payload.access_token) throw new Error(payload.error_message ?? payload.error_type ?? "Instagram OAuth token exchange failed.");
    if (!payload.user_id) throw new Error("Instagram OAuth response did not include an account identifier.");
    const credentialReference = `secret://affiliateos/social/instagram/${encodeURIComponent(payload.user_id)}`;
    return {
      accountReference: payload.user_id,
      credentialReference,
      connection: {
        provider: "instagram",
        grantedScopes: this.scopes
      }
    };
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try { return JSON.parse(text) as T; } catch { throw new Error(`OAuth provider returned invalid JSON (HTTP ${response.status}).`); }
}
