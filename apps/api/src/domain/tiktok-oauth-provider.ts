import type { SocialOAuthProvider } from "./oauth.js";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  open_id?: string;
  user_id?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

export type TikTokOAuthConfiguration = {
 clientKey: string;
 clientSecret: string;
 scopes?: string[];
 fetchImpl?: typeof fetch;
};

export class TikTokOAuthProvider implements SocialOAuthProvider {
  readonly platform = "tiktok";
  readonly authorizationEndpoint = "https://www.tiktok.com/v2/auth/authorize/";

  private readonly fetchImpl: typeof fetch;
  private readonly scopes: string[];

  constructor(private readonly configuration: TikTokOAuthConfiguration) {
    this.fetchImpl = configuration.fetchImpl ?? fetch;
    this.scopes = configuration.scopes ?? ["user.info.basic", "video.publish"];
    if (!configuration.clientKey.trim() || !configuration.clientSecret.trim()) {
      throw new Error("TikTok OAuth client credentials are required.");
    }
    if (!this.scopes.includes("video.publish")) {
      throw new Error("TikTok publishing requires the video.publish scope.");
    }
  }

  createAuthorizationUrl(input: { state: string; redirectUri: string }): string {
    const url = new URL(this.authorizationEndpoint);
    url.searchParams.set("client_key", this.configuration.clientKey);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.scopes.join(","));
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);
    return url.toString();
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<{ accountReference: string; credentialReference: string; connection?: Record<string, unknown> }> {
    const body = new URLSearchParams({
      client_key: this.configuration.clientKey,
      client_secret: this.configuration.clientSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri
    });
    const response = await this.fetchImpl("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    const payload = await readJson<TokenResponse>(response);
    if (!response.ok || !payload.access_token) throw new Error(payload.error_description ?? payload.error ?? "TikTok OAuth token exchange failed.");
    const accountReference = payload.open_id ?? payload.user_id;
    if (!accountReference) throw new Error("TikTok OAuth response did not include an account identifier.");
    const credentialReference = `secret://affiliateos/social/tiktok/${encodeURIComponent(accountReference)}`;
    return {
      accountReference,
      credentialReference,
      connection: {
        provider: "tiktok",
        openId: payload.open_id,
        grantedScopes: payload.scope?.split(",").map((scope) => scope.trim()).filter(Boolean) ?? [],
        accessTokenExpiresInSeconds: payload.expires_in,
        refreshTokenExpiresInSeconds: payload.refresh_expires_in
      }
    };
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try { return JSON.parse(text) as T; } catch { throw new Error(`OAuth provider returned invalid JSON (HTTP ${response.status}).`); }
}
