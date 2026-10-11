import type { Content, SocialAccount } from "@affiliateos/shared";
import type { MediaAsset } from "./media-asset.js";
import type { PublicationOperation } from "./publication-operation.js";
import type { PublicationCheckResult, PublishOutcome, SocialPublisher } from "./distribution-engine.js";

export interface TikTokCreatorInfo { creatorNickname?: string; privacyLevelOptions: string[]; commentDisabled: boolean; duetDisabled: boolean; stitchDisabled: boolean; maxVideoPostDurationSec?: number; }
export interface TikTokContentPublisherClient {
  publish(input: { content: Content; account: SocialAccount; mediaAssets: MediaAsset[]; idempotencyKey: string }): Promise<PublishOutcome>;
  checkPublication(input: { content: Content; account: SocialAccount; mediaAssets: MediaAsset[]; operation: PublicationOperation }): Promise<PublicationCheckResult>;
  getCreatorInfo(account: SocialAccount): Promise<TikTokCreatorInfo>;
}
export class TikTokContentPublisher implements SocialPublisher {
  readonly provider = "tiktok-content-posting";
  constructor(private readonly client: TikTokContentPublisherClient) {}
  supports(platform: string): boolean { return platform === "tiktok"; }
  supportsContent(content: Content): boolean { return content.platform === "tiktok" && Boolean(content.mediaAssetIds?.length); }
  publish(input: { content: Content; account: SocialAccount; credential?: unknown; mediaAssets?: MediaAsset[]; idempotencyKey: string }): Promise<PublishOutcome> {
    if (!input.mediaAssets?.length) return Promise.reject(new Error("TikTok publishing requires at least one media asset."));
    if (!input.mediaAssets.some((asset) => asset.kind === "video" || asset.kind === "image")) return Promise.reject(new Error("TikTok direct publishing requires a video or image media asset."));
    return this.client.publish({ content: input.content, account: input.account, mediaAssets: input.mediaAssets, idempotencyKey: input.idempotencyKey });
  }
  checkPublication(input: { content: Content; account: SocialAccount; credential?: unknown; mediaAssets?: MediaAsset[]; operation: PublicationOperation }): Promise<PublicationCheckResult> { return this.client.checkPublication({ content: input.content, account: input.account, mediaAssets: input.mediaAssets ?? [], operation: input.operation }); }
  getCreatorInfo(account: SocialAccount): Promise<TikTokCreatorInfo> { return this.client.getCreatorInfo(account); }
}