import type { Content, SocialAccount } from "@affiliateos/shared";
import type { MediaAsset } from "./media-asset.js";
import type { PublicationOperation } from "./publication-operation.js";
import type { PublicationCheckResult, PublishOutcome } from "./distribution-engine.js";
import type { InstagramContentPublisherClient } from "./instagram-content-publisher.js";

type InstagramMediaResponse = { id?: string; access_token?: string; error?: { message?: string; type?: string; code?: number } };
type InstagramPublishResponse = { id?: string; error?: { message?: string; type?: string; code?: number } };
type InstagramContainerStatusResponse = { id?: string; status_code?: string; status?: string; error?: { message?: string; type?: string; code?: number } };

export type InstagramGraphPublishingClientConfiguration = {
  accessTokenResolver: (account: SocialAccount) => Promise<string>;
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
    if (asset.source !== "url" || !this.isHttpsUrl(asset.reference)) {
      throw new Error("Instagram publishing requires a public HTTPS media URL.");
    }
    const accountId = input.account.accountReference;
    if (!accountId) throw new Error("Instagram publishing requires an account reference.");

    const isVideo = asset.kind === "video";
    const container = await this.request<InstagramMediaResponse>(`/${encodeURIComponent(accountId)}/media`, accessToken, {
      method: "POST",
      body: new URLSearchParams(isVideo
        ? { media_type: "REELS", video_url: asset.reference, caption: input.content.caption ?? input.content.title ?? "", access_token: accessToken }
        : { image_url: asset.reference, caption: input.content.caption ?? input.content.title ?? "", access_token: accessToken })
    });
    if (!container.id) throw new Error(container.error?.message ?? "Instagram did not return a media container id.");

    if (isVideo) {
      return { status: "accepted", providerOperationId: container.id };
    }

    const publicationId = await this.publishContainer(accountId, container.id, accessToken);
    return { status: "published", providerOperationId: publicationId };
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
      return { status: "published", externalPostId: result.id ?? input.operation.providerOperationId };
    }
    if (status === "ERROR" || status === "EXPIRED") {
      return { status: "failed", error: result.status ?? result.error?.message ?? "Instagram media container failed." };
    }
    return { status: "processing" };
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
