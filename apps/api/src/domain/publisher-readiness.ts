import type { ContentPlatform } from "@affiliateos/shared";
import type { SocialPublisher } from "./distribution-engine.js";
import type { SocialAccountRepository } from "./repository.js";

export type PublisherReadinessStatus = "ready" | "unconfigured" | "unsupported";

export type PublisherReadiness = {
  platform: ContentPlatform;
  status: PublisherReadinessStatus;
  publisherConfigured: boolean;
  credentialResolutionConfigured: boolean;
  activeAccountConfigured: boolean;
  credentialReferenceConfigured: boolean;
};

const platforms: ContentPlatform[] = ["tiktok", "instagram", "facebook", "youtube-shorts", "x", "threads"];

export class PublisherReadinessService {
  constructor(
    private readonly publishers: SocialPublisher[],
    private readonly credentialResolverConfigured: boolean,
    private readonly socialAccounts?: SocialAccountRepository
  ) {}

  async list(): Promise<PublisherReadiness[]> {
    const accounts = this.socialAccounts ? await this.socialAccounts.list() : [];
    return platforms.map((platform) => this.get(platform, accounts));
  }

  get(platform: ContentPlatform, accounts: Awaited<ReturnType<SocialAccountRepository["list"]>> = []): PublisherReadiness {
    const publisherConfigured = this.publishers.some((publisher) => publisher.supports(platform));
    const platformAccounts = accounts.filter((account) => account.platform === platform && account.status === "active");
    const activeAccountConfigured = platformAccounts.length > 0;
    const credentialReferenceConfigured = platformAccounts.some((account) => Boolean(account.credentialReference?.trim()));
    const status: PublisherReadinessStatus = !publisherConfigured
      ? "unsupported"
      : !this.credentialResolverConfigured || !activeAccountConfigured || !credentialReferenceConfigured
        ? "unconfigured"
        : "ready";

    return {
      platform,
      status,
      publisherConfigured,
      credentialResolutionConfigured: this.credentialResolverConfigured,
      activeAccountConfigured,
      credentialReferenceConfigured
    };
  }
}
