import { randomUUID, createHash } from "node:crypto";
import type { Content, SocialAccount, TikTokPublicationApproval } from "@affiliateos/shared";
import type { PublicationDispatchReservationRepository } from "./publication-dispatch-reservation.js";
import type { AffiliatePublicationEligibilityValidator } from "./affiliate-publication-eligibility.js";
import type { ContentService } from "./content.js";
import type { MediaAssetRepository } from "./media-asset.js";
import { publisherSupportsContent, type PublicationCheckResult, type SocialPublisher } from "./distribution-engine.js";
import type { PublicationOperation } from "./publication-operation.js";
import type { ContentProductRepository, SocialAccountRepository } from "./repository.js";
import type { ProductMediaAssetRepository } from "./product-media-ingestion.js";
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
    private readonly dispatchReservations?: PublicationDispatchReservationRepository
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
      // Instagram must validate immutable source records before reservation, but must
      // not resolve provider-facing URLs until the durable reservation is dispatching.
      // Keep TikTok and every non-Instagram publisher on the existing path.
      const isInstagramGraph = content.platform === "instagram" && publisher.provider === "instagram-graph";
      const rawInstagramMediaAssets = isInstagramGraph ? await this.loadRawMediaAssets(content) : undefined;
      if (rawInstagramMediaAssets) {
        const linked = await this.loadLinkedProductIds(content);
        await assertProductMediaRightsForPublication(rawInstagramMediaAssets, linked, this.productMediaAssets);
      }
      const mediaAssets = isInstagramGraph
        ? rawInstagramMediaAssets!
        : await this.resolveMediaAssets(content, false);
      const credential = await this.resolveCredential(account);
      let reservation: import("./publication-dispatch-reservation.js").PublicationDispatchReservation | undefined;
      if (isInstagramGraph) {
        if (!jobId || !this.dispatchReservations) throw new Error("Instagram publication requires a durable dispatch reservation repository and job ID.");
        const rawMediaAssets = rawInstagramMediaAssets!;
        const linkedProducts = this.contentProducts ? await this.contentProducts.listByContent(content.id) : [];
        const linkedProductIds = [...new Set([...linkedProducts.map((item) => item.productId), ...(content.productId ? [content.productId] : [])])];
        const mediaIntegrity = await createPublicationMediaIntegritySnapshot(rawMediaAssets, linkedProductIds, this.productMediaAssets);
        const snapshot = {
          content: { id: content.id, platform: content.platform, contentType: content.contentType, title: content.title ?? null, caption: content.caption ?? null, script: content.script ?? null, cta: content.cta ?? null, mediaAssetIds: content.mediaAssetIds ?? [], productId: content.productId ?? null, socialAccountId: content.socialAccountId ?? null },
          account: { id: account.id, platform: account.platform, accountReference: account.accountReference },
          mediaAssetIds: mediaAssets.map((asset) => asset.id).sort(),
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
      // This is intentionally after reserved -> dispatching: any signed public
      // media URL is now fenced by a durable active reservation. If URL resolution
      // fails, no provider request was made, so close the reservation as failed
      // instead of leaving a permanent dispatching fence.
      let providerMediaAssets: typeof mediaAssets;
      try {
        providerMediaAssets = isInstagramGraph
          ? await this.resolveMediaAssets(content, false)
          : mediaAssets;
      } catch (error) {
        if (reservation && this.dispatchReservations) {
          const message = error instanceof Error ? error.message : String(error);
          await this.dispatchReservations.transition(reservation.id, ["dispatching"], {
            ...reservation, state: "failed", lastError: message.slice(0, 1000),
            resolvedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
          });
        }
        throw error;
      }
      let result: Awaited<ReturnType<SocialPublisher["publish"]>>;
      try {
        result = await publisher.publish({ content, account, credential, mediaAssets: providerMediaAssets, idempotencyKey, tiktokApproval });
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

  private async loadRawMediaAssets(content: Content) {
    if (!this.mediaAssets || !content.mediaAssetIds?.length) return [];
    const assets = await Promise.all(content.mediaAssetIds.map((id) => this.mediaAssets?.findById(id)));
    if (assets.some((asset) => !asset)) throw new Error("One or more configured media assets do not exist.");
    const resolved = assets as NonNullable<(typeof assets)[number]>[];
    if (resolved.some((asset) => asset.contentId !== content.id)) throw new Error("A configured media asset does not belong to the content.");
    return resolved;
  }

  private async loadLinkedProductIds(content: Content): Promise<string[]> {
    const linkedProducts = this.contentProducts ? await this.contentProducts.listByContent(content.id) : [];
    return [...new Set([...linkedProducts.map((item) => item.productId), ...(content.productId ? [content.productId] : [])])];
  }

  private async resolveMediaAssets(content: Content, requireProductMediaRights = false) {
    const resolved = await this.loadRawMediaAssets(content);
    const linkedProductIds = await this.loadLinkedProductIds(content);
    if (requireProductMediaRights) {
      await assertProductMediaRightsForPublication(resolved, linkedProductIds, this.productMediaAssets);
    }
    return resolvePublisherMediaAssets(content, resolved, this.mediaStorage, linkedProductIds);
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
