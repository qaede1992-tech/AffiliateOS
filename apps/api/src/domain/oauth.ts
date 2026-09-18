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
export interface SocialOAuthProviderRegistry { get(platform: string): SocialOAuthProvider | undefined; }
export interface OAuthState { state: string; platform: string; redirectUri: string; expiresAt: string; }
export interface OAuthStateRepository { save(state: OAuthState): Promise<OAuthState>; findByState(state: string): Promise<OAuthState | undefined>; remove(state: string): Promise<void>; }

export class InMemorySocialOAuthProviderRegistry implements SocialOAuthProviderRegistry {
  private readonly providers = new Map<string, SocialOAuthProvider>();
  register(provider: SocialOAuthProvider): void {
    if (this.providers.has(provider.platform)) throw new Error(`Social OAuth provider already registered: ${provider.platform}`);
    this.providers.set(provider.platform, provider);
  }
  get(platform: string) { return this.providers.get(platform); }
}

export class InMemoryOAuthStateRepository implements OAuthStateRepository {
  private readonly states = new Map<string, OAuthState>();
  async save(state: OAuthState): Promise<OAuthState> { this.states.set(state.state, state); return state; }
  async findByState(state: string): Promise<OAuthState | undefined> { return this.states.get(state); }
  async remove(state: string): Promise<void> { this.states.delete(state); }
}

export class SocialOAuthService {
  constructor(
    private readonly providers: SocialOAuthProviderRegistry,
    private readonly accounts: SocialAccountRepository,
    private readonly states: OAuthStateRepository = new InMemoryOAuthStateRepository(),
    private readonly stateTtlMs = DEFAULT_STATE_TTL_MS
  ) {}

  async start(platform: string, redirectUri: string): Promise<{ authorizationUrl: string; state: string; expiresAt: string }> {
    const provider = this.providers.get(platform);
    if (!provider) throw new DomainError("SOCIAL_OAUTH_UNSUPPORTED", "OAuth is not configured for this platform.", 404);
    const state = randomUUID();
    const expiresAt = new Date(Date.now() + this.stateTtlMs).toISOString();
    await this.states.save({ state, platform, redirectUri, expiresAt });
    return { authorizationUrl: provider.createAuthorizationUrl({ state, redirectUri }), state, expiresAt };
  }

  async callback(platform: string, code: string, state: string): Promise<SocialAccountView> {
    const pending = await this.states.findByState(state);
    if (!pending || pending.platform !== platform) throw new DomainError("INVALID_SOCIAL_OAUTH_STATE", "The OAuth state is invalid.", 400);
    await this.states.remove(state);
    if (Date.parse(pending.expiresAt) <= Date.now()) throw new DomainError("EXPIRED_SOCIAL_OAUTH_STATE", "The OAuth state has expired.", 400);

    const provider = this.providers.get(platform);
    if (!provider) throw new DomainError("SOCIAL_OAUTH_UNSUPPORTED", "OAuth is not configured for this platform.", 404);
    if (!code.trim()) throw new DomainError("INVALID_SOCIAL_OAUTH_CODE", "The OAuth callback code is required.", 400);

    const exchanged = await provider.exchangeCode({ code, redirectUri: pending.redirectUri });
    if (!exchanged.accountReference?.trim() || !exchanged.credentialReference?.trim()) {
      throw new DomainError("INVALID_SOCIAL_OAUTH_RESULT", "The OAuth provider returned an invalid account result.", 502);
    }
    const existing = await this.accounts.findByPlatformAccount(platform, exchanged.accountReference);
    const updatedAt = new Date().toISOString();
    const account: SocialAccount = existing
      ? { ...existing, status: "active", connection: exchanged.connection ?? existing.connection, credentialReference: exchanged.credentialReference, updatedAt }
      : { id: randomUUID(), platform, accountReference: exchanged.accountReference, status: "active", connection: exchanged.connection ?? {}, credentialReference: exchanged.credentialReference, createdAt: updatedAt, updatedAt };
    const saved = await this.accounts.save(account);
    const { credentialReference: _credentialReference, ...safe } = saved;
    return { ...safe, hasCredentialReference: true };
  }
}
