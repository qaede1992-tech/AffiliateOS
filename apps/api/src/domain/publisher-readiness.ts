import type { ContentPlatform } from "@affiliateos/shared";
import type { SocialPublisher } from "./distribution-engine.js";

export type PublisherReadinessStatus = "ready" | "unconfigured" | "unsupported";

export type PublisherReadiness = {
  platform: ContentPlatform;
  status: PublisherReadinessStatus;
  publisherConfigured: boolean;
  credentialResolutionConfigured: boolean;
};

const platforms: ContentPlatform[] = ["tiktok", "instagram", "facebook", "youtube-shorts", "x", "threads"];

export class PublisherReadinessService {
  constructor(
    private readonly publishers: SocialPublisher[],
    private readonly credentialResolverConfigured: boolean
  ) {}

  list(): PublisherReadiness[] {
    return platforms.map((platform) => this.get(platform));
  }

  get(platform: ContentPlatform): PublisherReadiness {
    const publisherConfigured = this.publishers.some((publisher) => publisher.supports(platform));
    const status: PublisherReadinessStatus = !publisherConfigured
      ? "unsupported"
      : this.credentialResolverConfigured
        ? "ready"
        : "unconfigured";

    return { platform, status, publisherConfigured, credentialResolutionConfigured: this.credentialResolverConfigured };
  }
}
