import type { Content, SocialAccount } from "@affiliateos/shared";
import type { PublicationOperation } from "./publication-operation.js";
import type { PublicationCheckResult, PublishOutcome, SocialPublisher } from "./distribution-engine.js";

export interface TikTokContentPublisherClient {
  publish(input: { content: Content; account: SocialAccount; idempotencyKey: string }): Promise<PublishOutcome>;
  checkPublication(input: { content: Content; account: SocialAccount; operation: PublicationOperation }): Promise<PublicationCheckResult>;
}

/**
 * TikTok Content Posting API adapter boundary.
 *
 * The injected client owns OAuth access-token handling, media upload and the
 * current TikTok API version. No access token is stored in SocialAccount.
 */
export class TikTokContentPublisher implements SocialPublisher {
  readonly provider = "tiktok-content-posting";

  constructor(private readonly client: TikTokContentPublisherClient) {}

  supports(platform: string): boolean { return platform === "tiktok"; }

  publish(input: { content: Content; account: SocialAccount; credential?: unknown; idempotencyKey: string }): Promise<PublishOutcome> {
    return this.client.publish({ content: input.content, account: input.account, idempotencyKey: input.idempotencyKey });
  }

  checkPublication(input: { content: Content; account: SocialAccount; credential?: unknown; operation: PublicationOperation }): Promise<PublicationCheckResult> {
    return this.client.checkPublication({ content: input.content, account: input.account, operation: input.operation });
  }
}
