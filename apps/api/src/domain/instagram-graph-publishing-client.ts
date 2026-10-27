import type { Content, SocialAccount } from "@affiliateos/shared";
import type { MediaAsset } from "./media-asset.js";
import type { PublicationOperation } from "./publication-operation.js";
import type { PublicationCheckResult, PublishOutcome } from "./distribution-engine.js";
import type { InstagramContentPublisherClient } from "./instagram-content-publisher.js";

type InstagramMediaResponse = { id?: string; access_token?: string; error?: { message?: string; type?: string; code?: number } };
type InstagramPublishResponse = { id?: string; error?: { message?: string; type?: string; code?: number } };
type InstagramContainerStatusResponse = { id?: string; status_code?: string; status?: string; error?: { message?: string; type?: string; code?: number } };
type InstagramAccountMediaResponse = { data?: Array<{ id?: string; caption?: string; timestamp?: string; media_type?: string }> };

export type InstagramGraphPublishingClientConfiguration = {
  accessTokenResolver: (account: SocialAccount) => Promise<string>;
  mediaUrlResolver?: (asset: MediaAsset) => Promise<string>;
  fetchImpl?: typeof fetch;
  graphBaseUrl?: string;
};

export class InstagramGraphPublishingClient implements InstagramContentPublisherClient {
  private readonly fetchImpl: typeof fetch;
  private readonly graphBaseUrl: string;

  constructor(private readonly configuration: InstagramGraphPublishingClientConfiguration) {
    this.fetchImpl = configuration.fetchImpl ?? fetch;
    this.graphBaseUrl = (configuration.graphBaseUrl ?? "https://graph.instagram.com").replace(/\/$/, "");
  }

  async publish(input: { content: Content; account: SocialAccount; mediaAssets: MediaAsset[]; idempotencyKey: string }): Promise<PublishOutcome> {
    const accessToken = await this.configuration.accessTokenResolver(input.account);
    const asset = input.mediaAssets.find((candidate) => candidate.kind === "image" || candidate.kind === "video");
    if (!asset) throw new Error("Instagram publishing requires an image or video media asset.");
    const mediaUrl = asset.source === "url"
      ? asset.reference
      : await this.configuration.mediaUrlResolver?.(asset) ?? "";
    if (!this.isHttpsUrl(mediaUrl)) {
      throw new Error("Instagram publishing requires a publicly accessible HTTPS media URL.");
    }
    const accountId = input.account.accountReference;
    if (!accountId) throw new Error("Instagram publishing requires an account reference.");

    const isVideo = asset.kind === "video";
    const container = await this.request<InstagramMediaResponse>(`/${encodeURIComponent(accountId)}/media`, accessToken, {
      method: "POST",
      body: new URLSearchParams(isVideo
        ? { media_type: "REELS", video_url: mediaUrl, caption: input.content.caption ?? input.content.title ?? "", access_token: accessToken }
        : { image_url: mediaUrl, caption: input.content.caption ?? input.content.title ?? "", access_token: accessToken })
    });
    if (!container.id) throw new Error(container.error?.message ?? "Instagram did not return a media container id.");

    // Defer media_publish to reconciliation for both images and video. Persisting the
    // container ID first means a lost media_publish response cannot cause the job to
    // be retried as a fresh publication and create duplicate public content.
    return { status: "accepted", providerOperationId: container.id };
  }

  async checkPublication(input: { content: Content; account: SocialAccount; mediaAssets: MediaAsset[]; operation: PublicationOperation }): Promise<PublicationCheckResult> {
    const accessToken = await this.configuration.accessTokenResolver(input.account);
    const result = await this.request<InstagramContainerStatusResponse>(`/${encodeURIComponent(input.operation.providerOperationId)}`, accessToken, {
      method: "GET",
      body: undefined
    });
    const status = result.status_code?.toUpperCase();
    if (status === "FINISHED") {
      const externalPostId = await this.publishContainer(input.account.accountReference, input.operation.providerOperationId, accessToken);
      return { status: "published", externalPostId };
    }
    if (status === "PUBLISHED") {
      // Meta returns the container ID here, not the published media ID. Recover only
      // when exactly one recent account-media item matches this operation's caption
      // and time window; ambiguous matches stay pending to avoid false attribution.
      const recoveredId = await this.reconcilePublishedMediaId(input, accessToken);
      return recoveredId ? { status: "published", externalPostId: recoveredId } : { status: "processing" };
    }
    if (status === "ERROR" || status === "EXPIRED") {
      return { status: "failed", error: result.status ?? result.error?.message ?? "Instagram media container failed." };
    }
    return { status: "processing" };
  }

  private async reconcilePublishedMediaId(input: { content: Content; account: SocialAccount; mediaAssets: MediaAsset[]; operation: PublicationOperation }, accessToken: string): Promise<string | undefined> {
    const accountId = input.account.accountReference;
    if (!accountId) return undefined;
    const expectedCaption = input.content.caption ?? input.content.title ?? "";
    if (!expectedCaption) return undefined;
    const createdAt = Date.parse(input.operation.createdAt);
    if (!Number.isFinite(createdAt)) return undefined;
    const path = `/${encodeURIComponent(accountId)}/media`;
    const query = new URLSearchParams({ fields: "id,caption,timestamp,media_type", limit: "50" });
    const response = await this.request<InstagramAccountMediaResponse>(`${path}?${query.toString()}`, accessToken, { method: "GET", body: undefined });
    const matches = (response.data ?? []).filter((media) => {
      if (!media.id || media.caption !== expectedCaption || !media.timestamp) return false;
      const publishedAt = Date.parse(media.timestamp);
      if (!Number.isFinite(publishedAt) || publishedAt < createdAt - 120_000) return false;
      const asset = input.mediaAssets.find((candidate) => candidate.kind === "image" || candidate.kind === "video");
      if (asset?.kind === "video" && media.media_type !== "VIDEO" && media.media_type !== "REELS") return false;
      if (asset?.kind === "image" && media.media_type !== "IMAGE" && media.media_type !== "CAROUSEL_ALBUM") return false;
      return true;
    });
    return matches.length === 1 ? matches[0]?.id : undefined;
  }
  private async publishContainer(accountId: string, containerId: string, accessToken: string): Promise<string> {
    const publication = await this.request<InstagramPublishResponse>(`/${encodeURIComponent(accountId)}/media_publish`, accessToken, {
      method: "POST",
      body: new URLSearchParams({ creation_id: containerId, access_token: accessToken })
    });
    if (!publication.id) throw new Error(publication.error?.message ?? "Instagram did not return a published media id.");
    return publication.id;
  }

  private async request<T>(path: string, accessToken: string, init: RequestInit): Promise<T> {
    const url = new URL(this.graphBaseUrl + path);
    if (init.method === "GET") url.searchParams.set("access_token", accessToken);
    const response = await this.fetchImpl(url, {
      ...init,
      headers: { ...(init.headers ?? {}) }
    });
    const raw = await response.text();
    let payload: T;
    try { payload = JSON.parse(raw) as T; } catch { throw new Error(`Instagram returned invalid JSON (HTTP ${response.status}).`); }
    if (!response.ok) {
      const error = (payload as { error?: { message?: string } }).error?.message;
      throw new Error(error ?? `Instagram request failed (HTTP ${response.status}).`);
    }
    return payload;
  }

  private isHttpsUrl(value: string): boolean {
    try { return new URL(value).protocol === "https:"; } catch { return false; }
  }
}
