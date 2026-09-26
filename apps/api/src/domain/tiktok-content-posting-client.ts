import type { Content, SocialAccount } from "@affiliateos/shared";
import type { MediaAsset } from "./media-asset.js";
import type { PublicationOperation } from "./publication-operation.js";
import type { PublicationCheckResult, PublishOutcome } from "./distribution-engine.js";
import type { TikTokContentPublisherClient } from "./tiktok-content-publisher.js";

type TikTokCreatorInfo = {
  privacy_level_options?: string[];
  max_video_post_duration_sec?: number;
};

type TikTokInitResponse = {
  data?: { publish_id?: string; upload_url?: string };
  error?: { code?: string; message?: string; log_id?: string };
};

type TikTokStatusResponse = {
  data?: { status?: string; publicaly_available?: boolean; publicaly_available_post_id?: Array<string | number>; fail_reason?: string; post_id?: string };
  error?: { code?: string; message?: string };
};

export type TikTokContentPostingClientConfiguration = {
  accessTokenResolver: (account: SocialAccount) => Promise<string>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
};

export class TikTokContentPostingClient implements TikTokContentPublisherClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly configuration: TikTokContentPostingClientConfiguration) {
    this.fetchImpl = configuration.fetchImpl ?? fetch;
    this.baseUrl = (configuration.baseUrl ?? "https://open.tiktokapis.com").replace(/\/$/, "");
  }

  async publish(input: { content: Content; account: SocialAccount; mediaAssets: MediaAsset[]; idempotencyKey: string }): Promise<PublishOutcome> {
    const accessToken = await this.configuration.accessTokenResolver(input.account);
    const privacyLevel = this.readPrivacyLevel(input.account);
    if (!this.hasExplicitConsent(input.account)) {
      throw new Error("TikTok publishing requires explicit creator consent before media is sent.");
    }
    const creator = await this.creatorInfo(accessToken);
    const asset = input.mediaAssets.find((candidate) => candidate.kind === "video");
    if (!asset) throw new Error("TikTok direct video posting requires a video media asset.");
    if (asset.source !== "url") throw new Error("TikTok server-side publishing currently requires a public media URL.");
    if (!this.isHttpsUrl(asset.reference)) throw new Error("TikTok media URL must use HTTPS.");

    if (!creator.privacy_level_options?.includes(privacyLevel)) {
      throw new Error("TikTok privacy level is not permitted by the latest creator settings.");
    }
    const response = await this.requestJson<TikTokInitResponse>("/v2/post/publish/video/init/", accessToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        post_info: {
          title: input.content.caption ?? input.content.title ?? "",
          privacy_level: privacyLevel,
          disable_duet: this.readBoolean(input.account, "disableDuet"),
          disable_stitch: this.readBoolean(input.account, "disableStitch"),
          disable_comment: this.readBoolean(input.account, "disableComment")
        },
        source_info: { source: "PULL_FROM_URL", video_url: asset.reference }
      })
    });
    const publishId = response.data?.publish_id;
    if (!publishId) throw new Error(response.error?.message ?? "TikTok did not return a publish id.");
    return { status: "accepted", providerOperationId: publishId };
  }

  async checkPublication(input: { content: Content; account: SocialAccount; mediaAssets: MediaAsset[]; operation: PublicationOperation }): Promise<PublicationCheckResult> {
    const accessToken = await this.configuration.accessTokenResolver(input.account);
    const response = await this.requestJson<TikTokStatusResponse>("/v2/post/publish/status/fetch/", accessToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publish_id: input.operation.providerOperationId })
    });
    const status = response.data?.status?.toUpperCase();
    if (status === "PUBLISH_COMPLETE" || status === "PUBLISHED") {
      const publicPostId = response.data?.publicaly_available_post_id?.[0];
      return { status: "published", externalPostId: publicPostId != null ? String(publicPostId) : response.data?.post_id ?? input.operation.providerOperationId };
    }
    if (status === "FAILED" || status === "PUBLISH_FAILED") {
      return { status: "failed", error: response.data?.fail_reason ?? response.error?.message ?? "TikTok publication failed." };
    }
    return { status: "processing" };
  }

  private async creatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
    const response = await this.requestJson<{ data?: TikTokCreatorInfo; error?: { message?: string } }>("/v2/post/publish/creator_info/query/", accessToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    return response.data ?? {};
  }

  private async requestJson<T>(path: string, accessToken: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(this.baseUrl + path, {
      ...init,
      headers: { authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) }
    });
    const raw = await response.text();
    let payload: T;
    try { payload = JSON.parse(raw) as T; } catch { throw new Error(`TikTok returned invalid JSON (HTTP ${response.status}).`); }
    if (!response.ok) {
      const error = (payload as { error?: { message?: string } }).error?.message;
      throw new Error(error ?? `TikTok request failed (HTTP ${response.status}).`);
    }
    return payload;
  }

  private readPrivacyLevel(account: SocialAccount): string {
    const value = account.connection.tiktokPrivacyLevel;
    if (typeof value !== "string" || !value.trim()) throw new Error("TikTok account requires an explicit privacy level.");
    return value;
  }

  private hasExplicitConsent(account: SocialAccount): boolean {
    const value = account.connection.tiktokPublishingConsentAt;
    return typeof value === "string" && Number.isFinite(new Date(value).getTime());
  }

  private readBoolean(account: SocialAccount, key: string): boolean {
    return account.connection[`tiktok${key.charAt(0).toUpperCase()}${key.slice(1)}`] === true;
  }

  private isHttpsUrl(value: string): boolean {
    try { return new URL(value).protocol === "https:"; } catch { return false; }
  }
}
