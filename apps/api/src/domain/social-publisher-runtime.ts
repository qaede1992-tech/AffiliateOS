import type { SocialPublisher } from "./distribution-engine.js";
import { InstagramContentPublisher } from "./instagram-content-publisher.js";
import { InstagramGraphPublishingClient } from "./instagram-graph-publishing-client.js";
import { TikTokContentPublisher } from "./tiktok-content-publisher.js";
import { TikTokContentPostingClient } from "./tiktok-content-posting-client.js";
import type { SocialCredentialResolver } from "./social-credentials.js";

export type OfficialSocialPublisherRuntimeConfiguration = {
  credentialResolver?: SocialCredentialResolver;
  tiktok?: {
    fetchImpl?: typeof fetch;
    baseUrl?: string;
  };
  instagram?: {
    fetchImpl?: typeof fetch;
    graphBaseUrl?: string;
  };
};

/**
 * Builds only official publisher adapters. Publishing remains disabled when no
 * secret resolver is configured, so an opaque credential reference can never be
 * mistaken for an access token.
 */
export function createOfficialSocialPublishers(
  configuration: OfficialSocialPublisherRuntimeConfiguration
): SocialPublisher[] {
  const resolver = configuration.credentialResolver;
  if (!resolver) return [];

  return [
    new TikTokContentPublisher(
      new TikTokContentPostingClient({
        accessTokenResolver: async (account) => {
          const value = await resolver.resolve(account.credentialReference ?? "");
          return readAccessToken(value, "TikTok");
        },
        fetchImpl: configuration.tiktok?.fetchImpl,
        baseUrl: configuration.tiktok?.baseUrl
      })
    ),
    new InstagramContentPublisher(
      new InstagramGraphPublishingClient({
        accessTokenResolver: async (account) => {
          const value = await resolver.resolve(account.credentialReference ?? "");
          return readAccessToken(value, "Instagram");
        },
        fetchImpl: configuration.instagram?.fetchImpl,
        graphBaseUrl: configuration.instagram?.graphBaseUrl
      })
    )
  ];
}

function readAccessToken(value: unknown, provider: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "accessToken" in value) {
    const accessToken = (value as { accessToken?: unknown }).accessToken;
    if (typeof accessToken === "string" && accessToken.trim()) return accessToken.trim();
  }
  throw new Error(`${provider} social credential did not resolve to an access token.`);
}
