import type { ContentPlatform } from "@affiliateos/shared";
import type { SocialPublisher } from "./distribution-engine.js";
import type { SocialAccountRepository } from "./repository.js";
import type { SocialCredentialResolver } from "./social-credentials.js";

export type PublisherReadinessStatus = "ready" | "unconfigured" | "unsupported";

const requiredScopesByPlatform: Partial<Record<ContentPlatform, string>> = {
  tiktok: "video.publish",
  instagram: "instagram_business_content_publish"
};

export type PublisherReadiness = {
  platform: ContentPlatform;
  status: PublisherReadinessStatus;
  publisherConfigured: boolean;
  credentialResolutionConfigured: boolean;
  activeAccountConfigured: boolean;
  credentialReferenceConfigured: boolean;
  requiredScope?: string;
  requiredScopeGranted?: boolean;
  credentialResolvable?: boolean;
};

const platforms: ContentPlatform[] = ["tiktok", "instagram", "facebook", "youtube-shorts", "x", "threads"];

export class PublisherReadinessService {
  constructor(
    private readonly publishers: SocialPublisher[],
    private readonly credentialResolverConfigured: boolean,
    private readonly socialAccounts?: SocialAccountRepository,
    private readonly credentialResolver?: SocialCredentialResolver
  ) {}

  async list(): Promise<PublisherReadiness[]> {
    const accounts = this.socialAccounts ? await this.socialAccounts.list() : [];
    const readiness = await Promise.all(platforms.map(async (platform) => {
      const platformAccounts = accounts.filter((account) => account.platform === platform && account.status === "active");
      const credentialResolvable = this.credentialResolver
        ? await this.resolveAnyCredential(platformAccounts)
        : false;
      return this.get(platform, accounts, credentialResolvable);
    }));
    return readiness;
  }

  get(platform: ContentPlatform, accounts: Awaited<ReturnType<SocialAccountRepository["list"]>> = [], credentialResolvable = this.credentialResolver === undefined ? this.credentialResolverConfigured : false): PublisherReadiness {
    const publisherConfigured = this.publishers.some((publisher) => publisher.supports(platform));
    const platformAccounts = accounts.filter((account) => account.platform === platform && account.status === "active");
    const activeAccountConfigured = platformAccounts.length > 0;
    const credentialReferenceConfigured = platformAccounts.some((account) => Boolean(account.credentialReference?.trim()));
    const requiredScope = requiredScopesByPlatform[platform];
    const scopeEvidenceAvailable = platformAccounts.some((account) => Array.isArray(account.connection?.grantedScopes));
    const requiredScopeGranted = !requiredScope || !scopeEvidenceAvailable || platformAccounts.some((account) => {
      const grantedScopes = account.connection?.grantedScopes;
      return Array.isArray(grantedScopes) && grantedScopes.some((scope) => scope === requiredScope);
    });
    const status: PublisherReadinessStatus = !publisherConfigured
      ? "unsupported"
      : !this.credentialResolverConfigured || !activeAccountConfigured || !credentialReferenceConfigured || !credentialResolvable
        ? "unconfigured"
        : scopeEvidenceAvailable && !requiredScopeGranted
          ? "unconfigured"
          : "ready";

    return {
      platform,
      status,
      publisherConfigured,
      credentialResolutionConfigured: this.credentialResolverConfigured,
      activeAccountConfigured,
      credentialReferenceConfigured,
      ...(activeAccountConfigured && requiredScope ? { requiredScope, requiredScopeGranted } : {}),
      ...(activeAccountConfigured ? { credentialResolvable } : {})
    };
  }

  private async resolveAnyCredential(accounts: Awaited<ReturnType<SocialAccountRepository["list"]>>): Promise<boolean> {
    if (!this.credentialResolver) return false;
    for (const account of accounts) {
      const reference = account.credentialReference?.trim();
      if (!reference) continue;
      try {
        await this.credentialResolver.resolve(reference);
        return true;
      } catch {
        // Keep readiness redacted; a failed secret lookup must never expose its value or error details.
      }
    }
    return false;
  }
}
