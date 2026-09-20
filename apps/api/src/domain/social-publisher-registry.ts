import type { ContentPlatform } from "@affiliateos/shared";
import type { SocialPublisher } from "./distribution-engine.js";

export class SocialPublisherRegistry {
  private readonly publishers = new Map<string, SocialPublisher>();

  constructor(publishers: SocialPublisher[] = []) {
    for (const publisher of publishers) this.register(publisher);
  }

  register(publisher: SocialPublisher): void {
    const supportedPlatforms = [
      "tiktok",
      "instagram",
      "facebook",
      "youtube-shorts",
      "x",
      "threads"
    ].filter((platform) => publisher.supports(platform));

    if (supportedPlatforms.length === 0) {
      throw new Error("Social publisher must support at least one content platform.");
    }

    for (const platform of supportedPlatforms) {
      if (this.publishers.has(platform)) {
        throw new Error(`Social publisher already registered for ${platform}.`);
      }
      this.publishers.set(platform, publisher);
    }
  }

  get(platform: ContentPlatform): SocialPublisher | undefined {
    return this.publishers.get(platform);
  }

  list(): SocialPublisher[] {
    return [...new Set(this.publishers.values())];
  }
}
