import type { Content, SocialAccount } from "@affiliateos/shared";
import type { MediaAsset } from "./media-asset.js";
import type { PublicationOperation } from "./publication-operation.js";
import type { PublicationCheckResult, PublishOutcome } from "./distribution-engine.js";
import type { TikTokContentPublisherClient } from "./tiktok-content-publisher.js";

const FIVE_MB = 5 * 1024 * 1024;
const SIXTY_FOUR_MB = 64 * 1024 * 1024;
const MAX_VIDEO_SIZE = 4 * 1024 * 1024 * 1024;

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

export type TikTokMediaTransferMode = "FILE_UPLOAD" | "PULL_FROM_URL";

export type TikTokContentPostingClientConfiguration = {
  accessTokenResolver: (account: SocialAccount) => Promise<string>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  mediaTransferMode?: TikTokMediaTransferMode;
};

export class TikTokContentPostingClient implements TikTokContentPublisherClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly mediaTransferMode: TikTokMediaTransferMode;

  constructor(private readonly configuration: TikTokContentPostingClientConfiguration) {
    this.fetchImpl = configuration.fetchImpl ?? fetch;
    this.baseUrl = (configuration.baseUrl ?? "https://open.tiktokapis.com").replace(/\/$/, "");
    this.mediaTransferMode = configuration.mediaTransferMode ?? "FILE_UPLOAD";
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

    if (!creator.privacy_level_options?.includes(privacyLevel)) {
      throw new Error("TikTok privacy level is not permitted by the latest creator settings.");
    }

    if (this.mediaTransferMode === "PULL_FROM_URL") {
      if (asset.source !== "url") throw new Error("TikTok PULL_FROM_URL publishing requires a media URL.");
      if (!this.isHttpsUrl(asset.reference)) throw new Error("TikTok media URL must use HTTPS.");
      return this.initializePullFromUrl(input, accessToken, privacyLevel, asset.reference);
    }

    if (!this.isHttpsUrl(asset.reference)) {
      throw new Error("TikTok FILE_UPLOAD publishing requires an HTTPS media source that AffiliateOS can download.");
    }

    const videoSize = await this.resolveVideoSize(asset);
    const transfer = this.calculateTransfer(videoSize);
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
        source_info: {
          source: "FILE_UPLOAD",
          video_size: videoSize,
          chunk_size: transfer.chunkSize,
          total_chunk_count: transfer.totalChunkCount
        }
      })
    });

    const publishId = response.data?.publish_id;
    const uploadUrl = response.data?.upload_url;
    if (!publishId) throw new Error(response.error?.message ?? "TikTok did not return a publish id.");
    if (!uploadUrl) throw new Error(response.error?.message ?? "TikTok did not return an upload URL.");

    await this.uploadVideo(asset, uploadUrl, videoSize, transfer.chunkSize);
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

  private async initializePullFromUrl(
    input: { content: Content },
    accessToken: string,
    privacyLevel: string,
    reference: string
  ): Promise<PublishOutcome> {
    const response = await this.requestJson<TikTokInitResponse>("/v2/post/publish/video/init/", accessToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        post_info: {
          title: input.content.caption ?? input.content.title ?? "",
          privacy_level: privacyLevel
        },
        source_info: { source: "PULL_FROM_URL", video_url: reference }
      })
    });
    const publishId = response.data?.publish_id;
    if (!publishId) throw new Error(response.error?.message ?? "TikTok did not return a publish id.");
    return { status: "accepted", providerOperationId: publishId };
  }

  private async resolveVideoSize(asset: MediaAsset): Promise<number> {
    if (asset.byteSize !== undefined) {
      this.validateVideoSize(asset.byteSize);
      return asset.byteSize;
    }

    const response = await this.fetchImpl(asset.reference, { method: "HEAD" });
    if (!response.ok) throw new Error("Unable to determine TikTok media size (HTTP " + response.status + ").");
    const value = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(value)) {
      throw new Error("TikTok FILE_UPLOAD requires media byteSize or a Content-Length header.");
    }
    this.validateVideoSize(value);
    return value;
  }

  private async uploadVideo(asset: MediaAsset, uploadUrl: string, videoSize: number, chunkSize: number): Promise<void> {
    const response = await this.fetchImpl(asset.reference, { method: "GET" });
    if (!response.ok || !response.body) {
      throw new Error("Unable to download TikTok media source (HTTP " + response.status + ").");
    }

    const reader = response.body.getReader();
    let carry = Buffer.alloc(0);
    let offset = 0;

    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const incoming = Buffer.from(next.value);
        carry = carry.length ? Buffer.concat([carry, incoming]) : incoming;

        while (carry.length >= chunkSize) {
          const chunk = carry.subarray(0, chunkSize);
          carry = carry.subarray(chunkSize);
          await this.putUploadChunk(uploadUrl, chunk, offset, videoSize, asset.mimeType ?? "video/mp4");
          offset += chunk.length;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (carry.length > 0) {
      await this.putUploadChunk(uploadUrl, carry, offset, videoSize, asset.mimeType ?? "video/mp4");
      offset += carry.length;
    }

    if (offset !== videoSize) {
      throw new Error("TikTok media source size changed during download (expected " + videoSize + " bytes, received " + offset + ").");
    }
  }

  private async putUploadChunk(uploadUrl: string, chunk: Uint8Array, offset: number, totalSize: number, mimeType: string): Promise<void> {
    const firstByte = offset;
    const lastByte = offset + chunk.byteLength - 1;
    const response = await this.fetchImpl(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": mimeType,
        "content-length": String(chunk.byteLength),
        "content-range": "bytes " + firstByte + "-" + lastByte + "/" + totalSize
      },
      body: chunk
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "TikTok media upload failed (HTTP " + response.status + ").");
    }
  }

  private calculateTransfer(videoSize: number): { chunkSize: number; totalChunkCount: number } {
    if (videoSize < FIVE_MB) return { chunkSize: videoSize, totalChunkCount: 1 };
    const totalChunkCount = Math.ceil(videoSize / SIXTY_FOUR_MB);
    const chunkSize = Math.ceil(videoSize / totalChunkCount);
    return { chunkSize, totalChunkCount };
  }

  private validateVideoSize(videoSize: number): void {
    if (!Number.isSafeInteger(videoSize) || videoSize <= 0 || videoSize > MAX_VIDEO_SIZE) {
      throw new Error("TikTok video size must be a positive integer no larger than 4 GB.");
    }
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
      headers: { authorization: "Bearer " + accessToken, ...(init.headers ?? {}) }
    });
    const raw = await response.text();
    let payload: T;
    try { payload = JSON.parse(raw) as T; } catch { throw new Error("TikTok returned invalid JSON (HTTP " + response.status + ")."); }
    if (!response.ok) {
      const error = (payload as { error?: { message?: string } }).error?.message;
      throw new Error(error ?? "TikTok request failed (HTTP " + response.status + ").");
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
    return account.connection["tiktok" + key.charAt(0).toUpperCase() + key.slice(1)] === true;
  }

  private isHttpsUrl(value: string): boolean {
    try { return new URL(value).protocol === "https:"; } catch { return false; }
  }
}
