import { randomUUID } from "node:crypto";
import type { SocialAccount, SocialAccountView } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import { isAllowedOAuthRedirectUri } from "../http/redirect-uri.js";
import { redactSensitiveConnectionValues } from "./content.js";
import type { SocialAccountRepository } from "./repository.js";

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
export interface SocialOAuthProvider { readonly platform: string; readonly authorizationEndpoint: string; createAuthorizationUrl(input: { state: string; redirectUri: string }): string; exchangeCode(input: { code: string; redirectUri: string }): Promise<{ accountReference: string; credentialReference: string; connection?: Record<string, unknown> }>; }
export interface SocialOAuthProviderRegistry { get(platform: string): SocialOAuthProvider | undefined; }
export interface OAuthState { state: string; platform: string; redirectUri: string; expiresAt: string; }
export interface OAuthStateRepository { save(state: OAuthState): Promise<OAuthState>; consume(state: string, platform: string): Promise<OAuthState | undefined>; deleteExpired(before: string): Promise<void>; }
export class InMemorySocialOAuthProviderRegistry implements SocialOAuthProviderRegistry { private readonly providers = new Map<string, SocialOAuthProvider>(); register(provider: SocialOAuthProvider): void { if (this.providers.has(provider.platform)) throw new Error(`Social OAuth provider already registered: ${provider.platform}`); this.providers.set(provider.platform, provider); } get(platform: string) { return this.providers.get(platform); } }
export class InMemoryOAuthStateRepository implements OAuthStateRepository { private readonly states = new Map<string, OAuthState>(); async save(state: OAuthState): Promise<OAuthState> { this.states.set(state.state, state); return state; } async consume(state: string, platform: string): Promise<OAuthState | undefined> { const value = this.states.get(state); if (!value || value.platform !== platform) return undefined; this.states.delete(state); return value; } async deleteExpired(before: string): Promise<void> { for (const [key, value] of this.states) if (Date.parse(value.expiresAt) <= Date.parse(before)) this.states.delete(key); } }

const isUniqueViolation = (error: unknown): boolean => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "23505";

export class SocialOAuthService {
  constructor(private readonly providers: SocialOAuthProviderRegistry, private readonly accounts: SocialAccountRepository, private readonly states: OAuthStateRepository = new InMemoryOAuthStateRepository(), private readonly stateTtlMs = DEFAULT_STATE_TTL_MS) {}
  async start(platform: string, redirectUri: string): Promise<{ authorizationUrl: string; state: string; expiresAt: string }> {
    const provider = this.providers.get(platform);
    if (!provider) throw new DomainError("SOCIAL_OAUTH_UNSUPPORTED", "OAuth is not configured for this platform.", 404);
    if (!isAllowedOAuthRedirectUri(redirectUri)) throw new DomainError("INVALID_SOCIAL_OAUTH_REDIRECT_URI", "The OAuth redirect URI is not allowed.", 400);
    const now = new Date();
    await this.states.deleteExpired(now.toISOString());
    const state = randomUUID();
    const expiresAt = new Date(now.getTime() + this.stateTtlMs).toISOString();
    await this.states.save({ state, platform, redirectUri, expiresAt });
    return { authorizationUrl: provider.createAuthorizationUrl({ state, redirectUri }), state, expiresAt };
  }
  async callback(platform: string, code: string, state: string): Promise<SocialAccountView> { const pending = await this.states.consume(state, platform); if (!pending) throw new DomainError("INVALID_SOCIAL_OAUTH_STATE", "The OAuth state is invalid.", 400); if (Date.parse(pending.expiresAt) <= Date.now()) throw new DomainError("EXPIRED_SOCIAL_OAUTH_STATE", "The OAuth state has expired.", 400); const provider = this.providers.get(platform); if (!provider) throw new DomainError("SOCIAL_OAUTH_UNSUPPORTED", "OAuth is not configured for this platform.", 404); if (!code.trim()) throw new DomainError("INVALID_SOCIAL_OAUTH_CODE", "The OAuth callback code is required.", 400); const exchanged = await provider.exchangeCode({ code, redirectUri: pending.redirectUri }); if (!exchanged.accountReference?.trim() || !exchanged.credentialReference?.trim()) throw new DomainError("INVALID_SOCIAL_OAUTH_RESULT", "The OAuth provider returned an invalid account result.", 502); const existing = await this.accounts.findByPlatformAccount(platform, exchanged.accountReference); const updatedAt = new Date().toISOString(); const account: SocialAccount = existing ? { ...existing, status: "active", connection: exchanged.connection ?? existing.connection, credentialReference: exchanged.credentialReference, updatedAt } : { id: randomUUID(), platform, accountReference: exchanged.accountReference, status: "active", connection: exchanged.connection ?? {}, credentialReference: exchanged.credentialReference, createdAt: updatedAt, updatedAt }; let saved: SocialAccount; try { saved = await this.accounts.save(account); } catch (error) { if (!existing && isUniqueViolation(error)) { const raced = await this.accounts.findByPlatformAccount(platform, exchanged.accountReference); if (raced) { saved = await this.accounts.save({ ...raced, status: "active", connection: exchanged.connection ?? raced.connection, credentialReference: exchanged.credentialReference, updatedAt }); } else { throw error; } } else { throw error; } } const { credentialReference: _credentialReference, ...safe } = saved; return { ...safe, connection: redactSensitiveConnectionValues(saved.connection) as SocialAccount["connection"], hasCredentialReference: true }; }
}
