import { randomUUID, createHash } from "node:crypto";
import type { Content, SocialAccount, TikTokPublicationApproval } from "@affiliateos/shared";
import type { PublicationDispatchReservationRepository } from "./publication-dispatch-reservation.js";
import type { AffiliatePublicationEligibilityValidator } from "./affiliate-publication-eligibility.js";
import type { ContentService } from "./content.js";
import type { MediaAsset, MediaAssetRepository } from "./media-asset.js";
import { publisherSupportsContent, type PublicationCheckResult, type SocialPublisher } from "./distribution-engine.js";
import type { PublicationOperation } from "./publication-operation.js";
import type { ContentProductRepository, SocialAccountRepository } from "./repository.js";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "./product-media-ingestion.js";
import { assertProductMediaRightsForPublication, createPublicationMediaIntegritySnapshot } from "./product-media-publication-rights.js";
import type { SocialCredentialResolver } from "./social-credentials.js";
import type { SupabaseStorageClient } from "./supabase-storage.js";
import { resolvePublisherMediaAssets } from "./publisher-media-resolver.js";

export type PublishExecutionResult = {
  content: Content;
  account?: SocialAccount;
  publisher?: SocialPublisher;
  provider?: string;
  providerOperationId?: string;
  externalPostId?: string;
  status: "published" | "accepted" | "not_due" | "unsupported" | "failed";
};

export class PublisherExecutor {
  constructor(
    private readonly contentService: ContentService,
    private readonly socialAccounts: SocialAccountRepository,
    private readonly publishers: SocialPublisher[],
    private readonly credentialResolver?: SocialCredentialResolver,
    private readonly mediaAssets?: MediaAssetRepository,
    private readonly affiliatePublicationEligibility?: AffiliatePublicationEligibilityValidator,
    private readonly mediaStorage?: SupabaseStorageClient,
    private readonly contentProducts?: ContentProductRepository,
    private readonly productMediaAssets?: ProductMediaAssetRepository,
    private readonly dispatchReservations?: PublicationDispatchReservationRepository,
    private readonly productMediaDeliveryUrl?: (asset: ProductMediaAsset, context: { contentId: string; reservationId: string }) => Promise<string>
  ) {}

  async execute(contentId: string, now = new Date(), idempotencyKey = `content:${contentId}`, tiktokApproval?: TikTokPublicationApproval, jobId?: string): Promise<PublishExecutionResult> {
    const content = await this.contentService.get(contentId);
    if (content.status !== "scheduled") throw new Error("Only scheduled content can be published.");
    await this.contentService.validatePublicationEligibility(content);
    const scheduledAt = content.scheduledAt ? new Date(content.scheduledAt) : null;
    if (!scheduledAt || !Number.isFinite(scheduledAt.getTime())) throw new Error("Scheduled content requires a valid scheduledAt timestamp.");
    if (scheduledAt.getTime() > now.getTime()) return { content, status: "not_due" };

    try {
      await this.affiliatePublicationEligibility?.validate(content);
    } catch (error) {
      await this.contentService.update(content.id, { status: "failed" });
      throw error;
    }

    const account = await this.findAccount(content);
    const publisher = this.publishers.find((candidate) => publisherSupportsContent(candidate, content));
    if (!publisher) return { content, account, status: "unsupported" };
    if (!publisher.provider?.trim()) throw new Error("Publishers must declare a stable provider identifier before execution.");

    try {
      // Apply the new product-media rights gate only to Instagram. Keep TikTok and
      // other existing publisher paths unchanged during this staged rollout.
      const instagramDispatch = content.platform === "instagram" && publisher.provider === "instagram-graph";
      // Instagram product-media rights and source records are validated before
      // reserving, but provider-facing URLs are deliberately not minted until
      // after the durable reservation has been claimed.
      const sourceMediaAssets = instagramDispatch
        ? await this.loadMediaAssets(content, true)
        : undefined;
      const credential = await this.resolveCredential(account);
      let reservation: import("./publication-dispatch-reservation.js").PublicationDispatchReservation | undefined;
      if (content.platform === "instagram" && publisher.provider === "instagram-graph") {
        if (!jobId || !this.dispatchReservations) throw new Error("Instagram publication requires a durable dispatch reservation repository and job ID.");
        const configuredMediaAssets = await Promise.all((content.mediaAssetIds ?? []).map((id) => this.mediaAssets?.findById(id)));
        if (configuredMediaAssets.some((asset) => !asset)) throw new Error("Instagram reservation requires all configured source media records.");
        const rawMediaAssets = configuredMediaAssets as NonNullable<(typeof configuredMediaAssets)[number]>[];
        const linkedProducts = this.contentProducts ? await this.contentProducts.listByContent(content.id) : [];
        const linkedProductIds = [...new Set([...linkedProducts.map((item) => item.productId), ...(content.productId ? [content.productId] : [])])];
        const mediaIntegrity = await createPublicationMediaIntegritySnapshot(rawMediaAssets, linkedProductIds, this.productMediaAssets);
        const snapshot = {
          content: { id: content.id, platform: content.platform, contentType: content.contentType, title: content.title ?? null, caption: content.caption ?? null, script: content.script ?? null, cta: content.cta ?? null, mediaAssetIds: content.mediaAssetIds ?? [], productId: content.productId ?? null, socialAccountId: content.socialAccountId ?? null },
          account: { id: account.id, platform: account.platform, accountReference: account.accountReference },
          mediaAssetIds: (sourceMediaAssets ?? await this.resolveMediaAssets(content, false)).map((asset) => asset.id).sort(),
          ...(rawMediaAssets.length > 0 ? { mediaIntegrity } : {})
        };
        const snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
        const timestamp = now.toISOString();
        const proposed: import("./publication-dispatch-reservation.js").PublicationDispatchReservation = {
          id: randomUUID(), jobId, contentId: content.id, provider: publisher.provider,
          state: "reserved", idempotencyKey, snapshot, snapshotHash,
          createdAt: timestamp, updatedAt: timestamp
        };
        reservation = await this.dispatchReservations.reserve(proposed);
        if (reservation.snapshotHash !== snapshotHash || reservation.idempotencyKey !== idempotencyKey) {
          throw new Error("An existing Instagram dispatch reservation prevents a new provider request.");
        }
        const dispatching = await this.dispatchReservations.transition(reservation.id, ["reserved"], {
          ...reservation, state: "dispatching", dispatchStartedAt: timestamp, updatedAt: timestamp
        });
        if (!dispatching) throw new Error("Instagram dispatch reservation could not be claimed; provider request was not sent.");
        reservation = dispatching;
      }
      // Only now, after the Instagram reservation is in dispatching state,
      // resolve provider-facing media URLs. This is the insertion point for
      // reservation-bound local-volume delivery tokens.
      const mediaAssets = instagramDispatch
        ? await this.resolvePublisherAssets(content, sourceMediaAssets ?? [], reservation?.id)
        : await this.resolveMediaAssets(content, false);
      let result: Awaited<ReturnType<SocialPublisher["publish"]>>;
      try {
        result = await publisher.publish({ content, account, credential, mediaAssets, idempotencyKey, tiktokApproval });
      } catch (error) {
        if (reservation && this.dispatchReservations) {
          const message = error instanceof Error ? error.message : String(error);
          await this.dispatchReservations.transition(reservation.id, ["dispatching"], {
            ...reservation, state: "uncertain", lastError: message.slice(0, 1000), updatedAt: new Date().toISOString()
          });
        }
        throw error;
      }
      if (reservation && this.dispatchReservations && result.status === "published" && !result.externalPostId?.trim()) {
        // A provider success without a durable external identifier cannot be
        // reconciled safely after a restart. Preserve the dispatch fence and
        // require manual reconciliation instead of recording a false success.
        await this.dispatchReservations.transition(reservation.id, ["dispatching"], {
          ...reservation, state: "uncertain",
          lastError: "Instagram publisher returned published without an external post ID.",
          updatedAt: new Date().toISOString()
        });
        throw new Error("Instagram publisher returned published without an external post ID; automatic redispatch is blocked.");
      }
      if (reservation && this.dispatchReservations && result.status === "accepted" && !result.providerOperationId?.trim()) {
        // An accepted response without a durable provider operation ID cannot
        // be reconciled safely. Fence the reservation instead of retrying.
        await this.dispatchReservations.transition(reservation.id, ["dispatching"], {
          ...reservation,
          state: "uncertain",
          lastError: "Instagram publisher returned accepted without a provider operation ID.",
          updatedAt: new Date().toISOString()
        });
        throw new Error("Instagram publisher returned accepted without a provider operation ID; automatic redispatch is blocked.");
      }
      if (reservation && this.dispatchReservations) {
        const persisted = await this.dispatchReservations.transition(reservation.id, ["dispatching"], {
          ...reservation, state: result.status === "accepted" ? "accepted" : "published",
          ...(result.status === "accepted" ? { providerOperationId: result.providerOperationId } : { externalPostId: result.externalPostId }),
          updatedAt: new Date().toISOString()
        });
        // The provider may already have accepted the request. If durable state
        // cannot be advanced, fail closed: the dispatching reservation remains
        // a fence and the worker must not issue another provider request.
        if (!persisted) throw new Error("Instagram provider response could not be persisted; automatic redispatch is blocked.");
      }
    if (result.status === "accepted") {
      return { content, account, publisher, provider: publisher.provider ?? content.platform, providerOperationId: result.providerOperationId, status: "accepted" };
    }
    const updated = await this.contentService.update(content.id, { status: "published", publishedAt: now.toISOString() });
    return { content: updated, account, publisher, provider: publisher.provider ?? content.platform, externalPostId: result.externalPostId, status: "published" };
    } catch (error) {
      await this.contentService.update(content.id, { status: "failed" });
      throw error;
    }
  }

  async check(operation: PublicationOperation): Promise<{ content: Content; account: SocialAccount; result: PublicationCheckResult }> {
    const content = await this.contentService.get(operation.contentId);
    await this.contentService.validatePublicationEligibility(content);
    await this.affiliatePublicationEligibility?.validate(content);
    const account = await this.findAccount(content);
    const publisher = this.publishers.find((candidate) => publisherSupportsContent(candidate, content) && (candidate.provider ?? content.platform) === operation.provider);
    if (!publisher) throw new Error(`No publisher adapter is available for provider ${operation.provider}.`);
    if (!publisher.checkPublication) throw new Error(`Publisher ${operation.provider} does not support publication status checks.`);
    // Validate configured media references before reading social credentials.
    // Revalidate product-media provenance on every Instagram reconciliation pass,
    // immediately before the adapter can call media_publish for a FINISHED container.
    const mediaAssets = await this.resolveMediaAssets(content, content.platform === "instagram" && operation.provider === "instagram-graph");
    const credential = await this.resolveCredential(account);
    const result = await publisher.checkPublication({ content, account, credential, mediaAssets, operation });
    return { content, account, result };
  }

  private async resolveCredential(account: SocialAccount): Promise<unknown> {
    if (!account.credentialReference) return undefined;
    if (!this.credentialResolver) throw new Error("Social credential resolution is not configured.");
    return this.credentialResolver.resolve(account.credentialReference);
  }

  private async loadMediaAssets(content: Content, requireProductMediaRights = false) {
    if (!this.mediaAssets || !content.mediaAssetIds?.length) return [];
    const assets = await Promise.all(content.mediaAssetIds.map((id) => this.mediaAssets?.findById(id)));
    if (assets.some((asset) => !asset)) throw new Error("One or more configured media assets do not exist.");
    const resolved = assets as NonNullable<(typeof assets)[number]>[];
    if (resolved.some((asset) => asset.contentId !== content.id)) throw new Error("A configured media asset does not belong to the content.");
    const linkedProducts = this.contentProducts ? await this.contentProducts.listByContent(content.id) : [];
    const linkedProductIds = [...new Set([...linkedProducts.map((item) => item.productId), ...(content.productId ? [content.productId] : [])])];
    if (requireProductMediaRights) {
      // Apply the provenance gate to product-scoped assets while preserving
      // legacy URL/content-scoped publisher paths during this rollout.
      await assertProductMediaRightsForPublication(resolved, linkedProductIds, this.productMediaAssets);
    }
    return resolved;
  }

  private async resolvePublisherAssets(content: Content, sourceAssets: NonNullable<Awaited<ReturnType<PublisherExecutor["loadMediaAssets"]>>>, reservationId?: string): Promise<MediaAsset[]> {
    const linkedProducts = this.contentProducts ? await this.contentProducts.listByContent(content.id) : [];
    const linkedProductIds = [...new Set([...linkedProducts.map((item) => item.productId), ...(content.productId ? [content.productId] : [])])];
    if (!this.productMediaAssets) return resolvePublisherMediaAssets(content, sourceAssets, this.mediaStorage, linkedProductIds);
    const productAssets = (await Promise.all(linkedProductIds.map((id) => this.productMediaAssets!.listByProduct(id)))).flat();
    const localByReference = new Map<string, ProductMediaAsset>();
    for (const productAsset of productAssets) {
      if (productAsset.storageBackend !== "local_volume") continue;
      const reference = productAsset.bucket + "/" + productAsset.objectKey;
      if (localByReference.has(reference)) throw new Error("Local product media reference is ambiguous.");
      localByReference.set(reference, productAsset);
    }
    const resolved: MediaAsset[] = [];
    const legacy: MediaAsset[] = [];
    for (const asset of sourceAssets) {
      const productAsset = asset.source === "object-storage" ? localByReference.get(asset.reference) : undefined;
      if (!productAsset) { legacy.push(asset); continue; }
      if (!reservationId || !this.productMediaDeliveryUrl) throw new Error("Reservation-bound local product media delivery is not configured.");
      const url = await this.productMediaDeliveryUrl(productAsset, { contentId: content.id, reservationId });
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Local product media delivery URL must be credential-free HTTPS.");
      resolved.push({ ...asset, source: "url", reference: url });
    }
    return [...resolved, ...await resolvePublisherMediaAssets(content, legacy, this.mediaStorage, linkedProductIds)];
  }

  private async resolveMediaAssets(content: Content, requireProductMediaRights = false) {
    const sourceAssets = await this.loadMediaAssets(content, requireProductMediaRights);
    return this.resolvePublisherAssets(content, sourceAssets);
  }

  private async findAccount(content: Content): Promise<SocialAccount> {
    const accounts = await this.socialAccounts.list();
    if (content.socialAccountId) {
      const account = accounts.find((candidate) => candidate.id === content.socialAccountId);
      if (!account) throw new Error("The configured social account does not exist.");
      if (account.status !== "active") throw new Error("The configured social account is not active.");
      if (account.platform !== content.platform) throw new Error("The configured social account platform does not match content platform.");
      return account;
    }
    const account = accounts.find((candidate) => candidate.status === "active" && candidate.platform === content.platform);
    if (!account) throw new Error(`No active social account is available for ${content.platform}.`);
    return account;
  }
}
