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
      const credentialResolvableAccountIds = this.credentialResolver
        ? await this.resolveCredentialAccountIds(platformAccounts)
        : new Set<string>();
      return this.get(platform, accounts, credentialResolvableAccountIds);
    }));
    return readiness;
  }

  get(
    platform: ContentPlatform,
    accounts: Awaited<ReturnType<SocialAccountRepository["list"]>> = [],
    credentialResolvable: boolean | ReadonlySet<string> = this.credentialResolver === undefined ? this.credentialResolverConfigured : false
  ): PublisherReadiness {
    const publisherConfigured = this.publishers.some((publisher) => publisher.supports(platform));
    const platformAccounts = accounts.filter((account) => account.platform === platform && account.status === "active");
    const activeAccountConfigured = platformAccounts.length > 0;
    const credentialReferenceConfigured = platformAccounts.some((account) => Boolean(account.credentialReference?.trim()));
    const requiredScope = requiredScopesByPlatform[platform];
    const isCredentialResolvable = (account: (typeof platformAccounts)[number]) =>
      typeof credentialResolvable === "boolean" ? credentialResolvable : credentialResolvable.has(account.id);
    const credentialResolvableAccounts = platformAccounts.filter(isCredentialResolvable);
    const credentialResolvableForPlatform = credentialResolvableAccounts.length > 0;
    const scopeEvidenceAvailable = credentialResolvableAccounts.some((account) => Array.isArray(account.connection?.grantedScopes));
    const requiredScopeGranted = !requiredScope || !scopeEvidenceAvailable || credentialResolvableAccounts.some((account) => {
      const grantedScopes = account.connection?.grantedScopes;
      return Array.isArray(grantedScopes) && grantedScopes.includes(requiredScope);
    });
    const status: PublisherReadinessStatus = !publisherConfigured
      ? "unsupported"
      : !this.credentialResolverConfigured || !activeAccountConfigured || !credentialReferenceConfigured || !credentialResolvableForPlatform
        ? "unconfigured"
        : !requiredScopeGranted
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
      ...(activeAccountConfigured ? { credentialResolvable: credentialResolvableForPlatform } : {})
    };
  }

  private async resolveCredentialAccountIds(
    accounts: Awaited<ReturnType<SocialAccountRepository["list"]>>
  ): Promise<Set<string>> {
    const resolver = this.credentialResolver;
    if (!resolver) return new Set();

    const resolutionByReference = new Map<string, Promise<boolean>>();
    const resolvedAccountIds = await Promise.all(accounts.map(async (account) => {
      const reference = account.credentialReference?.trim();
      if (!reference) return undefined;

      let resolution = resolutionByReference.get(reference);
      if (!resolution) {
        resolution = resolver.resolve(reference).then(() => true).catch(() => false);
        resolutionByReference.set(reference, resolution);
      }
      return await resolution ? account.id : undefined;
    }));

    return new Set(resolvedAccountIds.filter((id): id is string => typeof id === "string"));
  }
}
