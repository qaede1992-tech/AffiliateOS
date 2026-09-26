import type { Content, SocialAccount } from "@affiliateos/shared";
import type { MediaAsset } from "./media-asset.js";
import type { PublicationOperation } from "./publication-operation.js";
import type { PublicationCheckResult, PublishOutcome, SocialPublisher } from "./distribution-engine.js";

export interface InstagramContentPublisherClient {
  publish(input: { content: Content; account: SocialAccount; mediaAssets: MediaAsset[]; idempotencyKey: string }): Promise<PublishOutcome>;
  checkPublication(input: { content: Content; account: SocialAccount; mediaAssets: MediaAsset[]; operation: PublicationOperation }): Promise<PublicationCheckResult>;
}

/**
 * Official Instagram publishing adapter boundary.
 *
 * The injected client owns Meta/Instagram API-version handling, media-container
 * creation, publication and token use. Secrets never enter Content or SocialAccount.
 */
export class InstagramContentPublisher implements SocialPublisher {
  readonly provider = "instagram-graph";

  constructor(private readonly client: InstagramContentPublisherClient) {}

  supports(platform: string): boolean {
    return platform === "instagram";
  }

  publish(input: { content: Content; account: SocialAccount; credential?: unknown; mediaAssets?: MediaAsset[]; idempotencyKey: string }): Promise<PublishOutcome> {
    if (!input.mediaAssets?.length) throw new Error("Instagram publishing requires at least one media asset.");
    return this.client.publish({ content: input.content, account: input.account, mediaAssets: input.mediaAssets, idempotencyKey: input.idempotencyKey });
  }

  checkPublication(input: { content: Content; account: SocialAccount; credential?: unknown; mediaAssets?: MediaAsset[]; operation: PublicationOperation }): Promise<PublicationCheckResult> {
    return this.client.checkPublication({ content: input.content, account: input.account, mediaAssets: input.mediaAssets ?? [], operation: input.operation });
  }
}
