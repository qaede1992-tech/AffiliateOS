import { randomUUID } from "node:crypto";
import type { SocialAccount, SocialAccountView } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { SocialAccountRepository } from "./repository.js";

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

export interface SocialOAuthProvider {
  readonly platform: string;
  readonly authorizationEndpoint: string;
  createAuthorizationUrl(input: { state: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; redirectUri: string }): Promise<{ accountReference: string; credentialReference: string; connection?: Record<string, unknown> }>;
}

export interface SocialOAuthProviderRegistry {
  get(platform: string): SocialOAuthProvider | undefined;
}

interface PendingOAuthState {
  state: string;
  platform: string;
  redirectUri: string;
  expiresAt: number;
}

export class InMemorySocialOAuthProviderRegistry implements SocialOAuthProviderRegistry {
  private readonly providers = new Map<string, SocialOAuthProvider>();
  register(provider: SocialOAuthProvider): void {
    if (this.providers.has(provider.platform)) throw new Error(`Social OAuth provider already registered: ${provider.platform}`);
    this.providers.set(provider.platform, provider);
  }
  get(platform: string) { return this.providers.get(platform); }
}

export class SocialOAuthService {
  private readonly states = new Map<string, PendingOAuthState>();

  constructor(
    private readonly providers: SocialOAuthProviderRegistry,
    private readonly accounts: SocialAccountRepository,
    private readonly stateTtlMs = DEFAULT_STATE_TTL_MS
  ) {}

  start(platform: string, redirectUri: string): { authorizationUrl: string; state: string; expiresAt: string } {
    const provider = this.providers.get(platform);
    if (!provider) throw new DomainError("SOCIAL_OAUTH_UNSUPPORTED", "OAuth is not configured for this platform.", 404);
    const state = randomUUID();
    const expiresAt = Date.now() + this.stateTtlMs;
    this.states.set(state, { state, platform, redirectUri, expiresAt });
    return { authorizationUrl: provider.createAuthorizationUrl({ state, redirectUri }), state, expiresAt: new Date(expiresAt).toISOString() };
  }

  async callback(platform: string, code: string, state: string): Promise<SocialAccountView> {
    const pending = this.states.get(state);
    if (!pending || pending.platform !== platform) throw new DomainError("INVALID_SOCIAL_OAUTH_STATE", "The OAuth state is invalid.", 400);
    this.states.delete(state);
    if (pending.expiresAt <= Date.now()) throw new DomainError("EXPIRED_SOCIAL_OAUTH_STATE", "The OAuth state has expired.", 400);

    const provider = this.providers.get(platform);
    if (!provider) throw new DomainError("SOCIAL_OAUTH_UNSUPPORTED", "OAuth is not configured for this platform.", 404);
    if (!code.trim()) throw new DomainError("INVALID_SOCIAL_OAUTH_CODE", "The OAuth callback code is required.", 400);

    const exchanged = await provider.exchangeCode({ code, redirectUri: pending.redirectUri });
    const existing = await this.accounts.findByPlatformAccount(platform, exchanged.accountReference);
    const createdAt = new Date().toISOString();
    const account: SocialAccount = existing
      ? { ...existing, status: "active", connection: exchanged.connection ?? existing.connection, credentialReference: exchanged.credentialReference, updatedAt: createdAt }
      : { id: randomUUID(), platform, accountReference: exchanged.accountReference, status: "active", connection: exchanged.connection ?? {}, credentialReference: exchanged.credentialReference, createdAt, updatedAt: createdAt };
    const saved = await this.accounts.save(account);
    const { credentialReference: _credentialReference, ...safe } = saved;
    return { ...safe, hasCredentialReference: true };
  }
}
