import type { Content, SocialAccount } from "@affiliateos/shared";
import type { PublicationOperation } from "./publication-operation.js";
import type { PublicationCheckResult, PublishOutcome, SocialPublisher } from "./distribution-engine.js";

export interface InstagramContentPublisherClient {
  publish(input: { content: Content; account: SocialAccount; idempotencyKey: string }): Promise<PublishOutcome>;
  checkPublication(input: { content: Content; account: SocialAccount; operation: PublicationOperation }): Promise<PublicationCheckResult>;
}

/**
 * Instagram publishing adapter boundary.
 *
 * The injected client owns Meta OAuth, account/page discovery and the current
 * Graph API media-container flow. Secrets never enter Content or SocialAccount.
 */
export class InstagramContentPublisher implements SocialPublisher {
  readonly provider = "instagram-graph";

  constructor(private readonly client: InstagramContentPublisherClient) {}

  supports(platform: string): boolean { return platform === "instagram"; }

  publish(input: { content: Content; account: SocialAccount; credential?: unknown; idempotencyKey: string }): Promise<PublishOutcome> {
    return this.client.publish({ content: input.content, account: input.account, idempotencyKey: input.idempotencyKey });
  }

  checkPublication(input: { content: Content; account: SocialAccount; credential?: unknown; operation: PublicationOperation }): Promise<PublicationCheckResult> {
    return this.client.checkPublication({ content: input.content, account: input.account, operation: input.operation });
  }
}
