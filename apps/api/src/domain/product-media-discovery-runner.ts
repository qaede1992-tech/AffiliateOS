import type { ContentPlatform, Product } from "@affiliateos/shared";
import { extractProductMediaCandidates, type ProductMediaCandidate } from "./product-media-discovery.js";
import { fetchPublicHttps } from "./public-https-fetch.js";
import type { ProductMediaAsset, ProductMediaIngestionPolicy, ProductMediaIngestionResult } from "./product-media-ingestion.js";
import { ProductMediaIngestionService } from "./product-media-ingestion.js";
import type { ProductMediaAssetRepository } from "./product-media-ingestion.js";
import type { SupabaseStorageClient } from "./supabase-storage.js";
import { ProductPromoVideoRenderer, type ProductPromoVideoRenderResult } from "./product-promo-video-renderer.js";
import { hasCurrentVerifiedRights } from "./product-media-publication-rights.js";
import { evaluateProductMediaAssetReadiness } from "./media-readiness-evaluator.js";
import { createHash, randomUUID } from "node:crypto";
import { buildProductMediaSearchQuery, getOpenverseHttpFailureDetails, searchOpenverseProductMedia, type ProductMediaCatalogCandidate, type ProductMediaCatalogSearchOptions } from "./product-media-catalog-search.js";
import { searchWikimediaCommonsProductMedia } from "./product-media-wikimedia-search.js";
import { assertOpenverseAvailable, recordOpenverseFailure, recordOpenverseSuccess } from "./openverse-provider-circuit.js";
import type { ProductMediaCandidateRepository } from "./product-media-candidate.js";
import type { ProductMediaDiscoveryAttemptRepository, ProductMediaDiscoveryOutcome } from "./product-media-discovery-attempt.js";

export interface ProductMediaDiscoveryPolicy extends ProductMediaIngestionPolicy {
  maxProductPageBytes?: number;
  maxCandidates?: number;
}

export interface ProductMediaDiscoveryResult extends ProductMediaIngestionResult {
  productId: string;
  pageFetched: boolean;
  hasVideo: boolean;
  candidatesFound?: number;
}

const safeErrorType = (error: unknown): string =>
  error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "UnknownError";

/**
 * Openverse's catalog adapter returns still images only. For products with a
 * model or SKU, also consult Commons whenever no video has been found, even
 * when Openverse already returned useful still-image candidates.
 */
export const shouldSearchWikimediaVideoFallback = (
  candidates: ProductMediaCatalogCandidate[],
  identity: { model?: string | null; sku?: string | null }
): boolean =>
  Boolean(identity.model?.trim() || identity.sku?.trim()) &&
  !candidates.some((candidate) => candidate.mediaKind === "video");

/** Merge provider results without duplicate landing pages; prefer video leads. */
export const mergeWikimediaVideoFallbackCandidates = (
  primary: ProductMediaCatalogCandidate[],
  fallback: ProductMediaCatalogCandidate[],
  maxResults = 10
): ProductMediaCatalogCandidate[] => {
  const byLandingPage = new Map<string, ProductMediaCatalogCandidate>();
  for (const candidate of [...primary, ...fallback]) {
    if (!byLandingPage.has(candidate.landingPageUrl)) {
      byLandingPage.set(candidate.landingPageUrl, candidate);
    }
  }
  return [...byLandingPage.values()]
    .sort((left, right) =>
      Number(right.mediaKind === "video") - Number(left.mediaKind === "video") ||
      right.identityScore - left.identityScore
    )
    .slice(0, maxResults);
};

const isShopeeHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "shopee.co.id" || host.endsWith(".shopee.co.id") ||
    host === "shopee.com" || host.endsWith(".shopee.com");
};

const isShopeeOwnedMediaHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return isShopeeHost(host) || host === "susercontent.com" || host.endsWith(".susercontent.com") ||
    host === "shopeeusercontent.com" || host.endsWith(".shopeeusercontent.com");
};

const hasUsableExplicitMediaUrl = (product: Product): boolean =>
  [product.imageUrl, product.videoUrl].some((value) => {
    if (!value?.trim()) return false;
    try {
      const url = new URL(value);
      // Shopee-owned CDN URLs are deliberately never fetched. They must therefore
      // not suppress Path 2 catalog discovery, which is the supported alternative
      // when an imported Shopee row contains only platform-hosted media URLs.
      return url.protocol === "https:" && !url.username && !url.password &&
        !isShopeeOwnedMediaHost(url.hostname);
    } catch {
      return false;
    }
  });

/**
 * Discovers public product media only after the caller has selected a candidate
 * using non-media affiliate criteria. It does not bypass login, CAPTCHA, or bot
 * protections. Shopee product pages are deliberately excluded from HTML extraction;
 * only media URLs explicitly supplied in the catalog may be ingested for Shopee.
 */
export class ProductMediaDiscoveryRunner {
  private readonly ingestion: ProductMediaIngestionService;
  private readonly bucketName: string;
  private readonly promoVideoRenderer: ProductPromoVideoRenderer;

  constructor(
    storage: SupabaseStorageClient,
    private readonly assets: ProductMediaAssetRepository,
    private readonly policy: ProductMediaDiscoveryPolicy,
    private readonly fetcher: typeof fetchPublicHttps = fetchPublicHttps,
    private readonly catalogCandidates?: ProductMediaCandidateRepository,
    private readonly catalogSearchOptions: ProductMediaCatalogSearchOptions = {},
    private readonly discoveryAttempts?: ProductMediaDiscoveryAttemptRepository
  ) {
    this.bucketName = storage.bucketName;
    this.ingestion = new ProductMediaIngestionService(storage, assets, policy, fetcher);
    this.promoVideoRenderer = new ProductPromoVideoRenderer(storage, assets, {
      maxInputBytes: policy.maxImageBytes,
      maxOutputBytes: policy.maxVideoBytes
    });
  }

  async generatePromoVideo(product: Product): Promise<ProductPromoVideoRenderResult> {
    return this.promoVideoRenderer.render(product);
  }

  async hasStoredVideo(productId: string): Promise<boolean> {
    return (await this.assets.listByProduct(productId)).some((asset) => asset.bucket === this.bucketName && asset.kind === "video");
  }

  /**
   * Reads product media rows once and derives all autonomous publication
   * gates/readiness signals from the same persisted snapshot.
   */
  async getPublicationReadinessSnapshot(
    productIds: string[],
    platforms: ContentPlatform[] = ["instagram", "tiktok"]
  ): Promise<{
    publishableMediaProductIds: string[];
    publishableVideoProductIds: string[];
    storedVideoProductIds: string[];
    mediaReadinessScores: Record<string, number>;
  }> {
    const uniqueProductIds = [...new Set(productIds)];
    const mediaReadinessScores: Record<string, number> = {};
    if (uniqueProductIds.length === 0) {
      return {
        publishableMediaProductIds: [],
        publishableVideoProductIds: [],
        storedVideoProductIds: [],
        mediaReadinessScores
      };
    }

    const assets = this.assets.listByProducts
      ? await this.assets.listByProducts(uniqueProductIds)
      : (await Promise.all(uniqueProductIds.map((productId) => this.assets.listByProduct(productId)))).flat();
    const uniquePlatforms = [...new Set(platforms.filter((platform) => platform === "instagram" || platform === "tiktok"))];
    const publishableMedia = new Set<string>();
    const publishableVideos = new Set<string>();
    const storedVideos = new Set<string>();

    for (const asset of assets) {
      if (!uniqueProductIds.includes(asset.productId) || asset.bucket !== this.bucketName) continue;
      const verified = hasCurrentVerifiedRights(asset);
      if ((asset.kind === "image" || asset.kind === "video") && verified) {
        publishableMedia.add(asset.productId);
      }
      if (asset.kind === "video") {
        storedVideos.add(asset.productId);
        if (verified) publishableVideos.add(asset.productId);
      }
    }

    for (const productId of uniqueProductIds) {
      const verifiedAssets = assets.filter((asset) =>
        asset.productId === productId &&
        asset.bucket === this.bucketName &&
        (asset.kind === "image" || asset.kind === "video") &&
        hasCurrentVerifiedRights(asset)
      );
      if (verifiedAssets.length === 0 || uniquePlatforms.length === 0) {
        mediaReadinessScores[productId] = 0;
        continue;
      }
      const platformScores = uniquePlatforms.map((platform) => {
        const assetScores = verifiedAssets.map((asset) => {
          const readiness = evaluateProductMediaAssetReadiness(platform, asset);
          if (readiness.checks.length === 0) return 0;
          const points = readiness.checks.reduce((sum, item) =>
            sum + (item.status === "pass" ? 1 : item.status === "unknown" ? 0.35 : 0), 0);
          return (points / readiness.checks.length) * 100;
        });
        return Math.max(...assetScores);
      });
      mediaReadinessScores[productId] = Math.round(
        (platformScores.reduce((sum, score) => sum + score, 0) / platformScores.length) * 100
      ) / 100;
    }

    return {
      publishableMediaProductIds: uniqueProductIds.filter((id) => publishableMedia.has(id)),
      publishableVideoProductIds: uniqueProductIds.filter((id) => publishableVideos.has(id)),
      storedVideoProductIds: uniqueProductIds.filter((id) => storedVideos.has(id)),
      mediaReadinessScores
    };
  }

  async listPublishableMediaProductIds(productIds: string[]): Promise<string[]> {
    const uniqueProductIds = [...new Set(productIds)];
    if (uniqueProductIds.length === 0) return [];
    const assets = this.assets.listByProducts
      ? await this.assets.listByProducts(uniqueProductIds)
      : (await Promise.all(uniqueProductIds.map((productId) => this.assets.listByProduct(productId)))).flat();
    const ids = new Set(assets.filter((asset) =>
      asset.bucket === this.bucketName &&
      (asset.kind === "image" || asset.kind === "video") &&
      hasCurrentVerifiedRights(asset)
    ).map((asset) => asset.productId));
    return uniqueProductIds.filter((productId) => ids.has(productId));
  }

  /**
   * Produces a conservative 0-100 technical-readiness score from currently
   * rights-verified, persisted assets. Unknown checks receive partial credit,
   * never a pass; no verified asset yields zero.
   */
  async listMediaReadinessScores(
    productIds: string[],
    platforms: ContentPlatform[] = ["instagram", "tiktok"]
  ): Promise<Record<string, number>> {
    const uniqueProductIds = [...new Set(productIds)];
    const uniquePlatforms = [...new Set(platforms.filter((platform) => platform === "instagram" || platform === "tiktok"))];
    const result: Record<string, number> = {};
    if (uniqueProductIds.length === 0) return result;
    const assets = this.assets.listByProducts
      ? await this.assets.listByProducts(uniqueProductIds)
      : (await Promise.all(uniqueProductIds.map((productId) => this.assets.listByProduct(productId)))).flat();
    for (const productId of uniqueProductIds) {
      const verified = assets.filter((asset) =>
        asset.productId === productId &&
        asset.bucket === this.bucketName &&
        (asset.kind === "image" || asset.kind === "video") &&
        hasCurrentVerifiedRights(asset)
      );
      if (verified.length === 0 || uniquePlatforms.length === 0) {
        result[productId] = 0;
        continue;
      }
      const platformScores = uniquePlatforms.map((platform) => {
        const assetScores = verified.map((asset) => {
          const readiness = evaluateProductMediaAssetReadiness(platform, asset);
          if (readiness.checks.length === 0) return 0;
          const points = readiness.checks.reduce((sum, item) =>
            sum + (item.status === "pass" ? 1 : item.status === "unknown" ? 0.35 : 0), 0);
          return (points / readiness.checks.length) * 100;
        });
        return Math.max(...assetScores);
      });
      result[productId] = Math.round((platformScores.reduce((sum, score) => sum + score, 0) / platformScores.length) * 100) / 100;
    }
    return result;
  }

  async listVideoProductIds(productIds: string[]): Promise<string[]> {
    return this.listProductIdsWithVideo(productIds, false);
  }

  async listPublishableVideoProductIds(productIds: string[]): Promise<string[]> {
    return this.listProductIdsWithVideo(productIds, true);
  }

  private async listProductIdsWithVideo(productIds: string[], requireVerifiedRights: boolean): Promise<string[]> {
    const uniqueProductIds = [...new Set(productIds)];
    if (uniqueProductIds.length === 0) return [];

    const assets = this.assets.listByProducts
      ? await this.assets.listByProducts(uniqueProductIds)
      : (await Promise.all(uniqueProductIds.map((productId) => this.assets.listByProduct(productId)))).flat();
    const productIdsWithVideo = new Set(assets.filter((asset) =>
      asset.bucket === this.bucketName &&
      asset.kind === "video" &&
      (!requireVerifiedRights || hasCurrentVerifiedRights(asset))
    ).map((asset) => asset.productId));
    return uniqueProductIds.filter((productId) => productIdsWithVideo.has(productId));
  }

  async discover(product: Product, nonMediaEligibilityPassed: boolean): Promise<ProductMediaDiscoveryResult> {
    const skipped: Array<{ url: string; reason: string }> = [];
    if (!nonMediaEligibilityPassed) {
      throw new Error("Product must pass non-media affiliate eligibility before discovery.");
    }
    const existing = await this.assets.listByProduct(product.id);
    if (existing.some((asset) => asset.bucket === this.bucketName && asset.kind === "video" && hasCurrentVerifiedRights(asset))) {
      return { productId: product.id, pageFetched: false, hasVideo: true, stored: existing, skipped };
    }
    let pageUrl: URL;
    try { pageUrl = new URL(product.productUrl); } catch {
      return { productId: product.id, pageFetched: false, hasVideo: false, stored: existing, skipped: [{ url: product.productUrl, reason: "Product page URL is invalid." }] };
    }
    if (pageUrl.protocol !== "https:" || pageUrl.username || pageUrl.password) {
      return { productId: product.id, pageFetched: false, hasVideo: false, stored: existing, skipped: [{ url: product.productUrl, reason: "Product page must be a credential-free HTTPS URL." }] };
    }

    // Shopee affiliate terms prohibit automated extraction of platform creative
    // materials. Never fetch or parse Shopee product HTML for media candidates.
    if (isShopeeHost(pageUrl.hostname)) {
      let candidatesFound = 0;
      // An explicitly supplied, non-Shopee HTTPS media URL is already a more
      // direct source than a catalog search. Avoid provider traffic and candidate
      // writes when ingestion can proceed from the supplied URL below.
      if (this.catalogCandidates && !hasUsableExplicitMediaUrl(product)) {
        const identity = {
          name: product.name,
          ...(product.category?.trim() ? { category: product.category } : {}),
          ...(product.discoverySignals?.productIdentity?.brand ? { brand: product.discoverySignals.productIdentity.brand } : {}),
          ...(product.discoverySignals?.productIdentity?.model ? { model: product.discoverySignals.productIdentity.model } : {}),
          ...(product.discoverySignals?.productIdentity?.sku ? { sku: product.discoverySignals.productIdentity.sku } : {}),
          ...(product.discoverySignals?.productIdentity?.variant ? { variant: product.discoverySignals.productIdentity.variant } : {})
        };
        const query = buildProductMediaSearchQuery(identity);
        const fingerprint = createHash("sha256").update(JSON.stringify({
          name: product.name.trim(),
          category: product.category?.trim() ?? "",
          productUrl: product.productUrl,
          imageUrl: product.imageUrl ?? "",
          videoUrl: product.videoUrl ?? "",
          query
        })).digest("hex");
        // A pending candidate already represents completed discovery work. Re-querying
        // external catalogs while an operator review is outstanding adds provider
        // traffic and candidate writes without improving publication readiness.
        let hasPendingCandidate = false;
        let candidateLookupFailed = false;
        try {
          if (this.catalogCandidates) {
            // Only a pending candidate for the same canonical product identity query
            // suppresses discovery. Stale candidates must not block updated metadata.
            if (this.catalogCandidates.hasPendingByProductAndQuery) {
              hasPendingCandidate = await this.catalogCandidates.hasPendingByProductAndQuery(product.id, query);
            } else {
              const pendingCandidates = await this.catalogCandidates.listPendingByProduct(product.id, 100);
              hasPendingCandidate = pendingCandidates.some((candidate) => candidate.query === query);
            }
          }
        } catch (error) {
          candidateLookupFailed = true;
          skipped.push({ url: product.productUrl, reason: "catalog_pending_candidate_check_unavailable" });
          console.warn(JSON.stringify({
            event: "product_media_pending_candidate_check_failed",
            productId: product.id,
            errorType: safeErrorType(error)
          }));
        }
        let shouldSearch = !hasPendingCandidate && !candidateLookupFailed;
        let claimed = false;
        let leaseUntil: string | undefined;
        let catalogOutcome: ProductMediaDiscoveryOutcome = candidateLookupFailed ? "provider_error" : hasPendingCandidate ? "success" : "no_results";
        if (shouldSearch && this.discoveryAttempts) {
          const now = new Date();
          leaseUntil = new Date(now.getTime() + 15 * 60_000).toISOString();
          try {
            claimed = await this.discoveryAttempts.claim({
              productId: product.id,
              fingerprint,
              now: now.toISOString(),
              leaseUntil
            });
            shouldSearch = claimed;
          } catch (error) {
            shouldSearch = false;
            skipped.push({ url: product.productUrl, reason: "catalog_discovery_cooldown_unavailable" });
            console.warn(JSON.stringify({
              event: "product_media_discovery_cooldown_claim_failed",
              productId: product.id,
              errorType: safeErrorType(error)
            }));
          }
        }
        if (shouldSearch) {
          let discovered: ProductMediaCatalogCandidate[] = [];
          let discoveryProvider: "openverse" | "wikimedia_commons" = "openverse";
          let openverseFailure: string | undefined;
          let openverseFailureDetails: ReturnType<typeof getOpenverseHttpFailureDetails> = null;
          let openverseFallbackReason: "provider_error" | "empty_structured_identity" | undefined;
          let discoveryFailed = false;
          try {
            try {
              assertOpenverseAvailable();
              discovered = await searchOpenverseProductMedia(identity, { ...this.catalogSearchOptions, maxResults: 10 });
              recordOpenverseSuccess();
              // Keep generic discovery to one provider request. Only spend a second
              // catalog request when Openverse is empty and the CSV supplied a model
              // or SKU that can make the Wikimedia query product-specific.
              if (shouldSearchWikimediaVideoFallback(discovered, identity)) {
                const primaryCount = discovered.length;
                openverseFallbackReason = primaryCount === 0 ? "empty_structured_identity" : undefined;
                console.info(JSON.stringify({
                  event: "product_media_catalog_provider_fallback",
                  primaryProvider: "openverse",
                  fallbackProvider: "wikimedia_commons",
                  fallbackReason: primaryCount === 0 ? "empty_structured_identity" : "video_not_found",
                  productId: product.id,
                  primaryCandidateCount: primaryCount
                }));
                try {
                  const fallbackCandidates = await searchWikimediaCommonsProductMedia(identity, { maxResults: 10 });
                  if (primaryCount === 0) discoveryProvider = "wikimedia_commons";
                  discovered = mergeWikimediaVideoFallbackCandidates(discovered, fallbackCandidates, 10);
                } catch (fallbackError) {
                  // Keep useful Openverse images if the optional video lookup fails.
                  if (primaryCount === 0) throw fallbackError;
                  console.warn(JSON.stringify({
                    event: "product_media_catalog_fallback_failed",
                    provider: "wikimedia_commons",
                    productId: product.id,
                    errorType: safeErrorType(fallbackError)
                  }));
                }
              }
            } catch (error) {
              openverseFailure = safeErrorType(error);
              openverseFallbackReason = "provider_error";
              openverseFailureDetails = getOpenverseHttpFailureDetails(error);
              recordOpenverseFailure(openverseFailureDetails);
              discoveryProvider = "wikimedia_commons";
              console.warn(JSON.stringify({
                event: "product_media_catalog_provider_fallback",
                primaryProvider: "openverse",
                fallbackProvider: "wikimedia_commons",
                productId: product.id,
                errorType: openverseFailure,
                ...(openverseFailureDetails ? {
                  failureDetails: {
                    endpoint: openverseFailureDetails.endpoint,
                    status: openverseFailureDetails.status,
                    contentType: openverseFailureDetails.contentType,
                    server: openverseFailureDetails.server,
                    cloudflareRayPresent: openverseFailureDetails.cloudflareRayPresent,
                    responseKind: openverseFailureDetails.responseKind
                  }
                } : {})
              }));
              discovered = await searchWikimediaCommonsProductMedia(identity, { maxResults: 10 });
            }
          } catch (error) {
            discoveryFailed = true;
            catalogOutcome = "provider_error";
            console.warn(JSON.stringify({
              event: "product_media_catalog_search_failed",
              provider: discoveryProvider,
              productId: product.id,
              errorType: safeErrorType(error)
            }));
            skipped.push({
              url: discoveryProvider === "openverse" ? "https://api.openverse.org/v1/images/" : "https://commons.wikimedia.org/w/api.php",
              reason: "catalog_discovery_failed"
            });
          }
          if (!discoveryFailed) {
            const now = new Date().toISOString();
            const accepted = discovered.filter((candidate): candidate is (typeof discovered)[number] & {
              identityStatus: "strong_match" | "review_required"
            } => candidate.identityStatus !== "rejected");
            const records = accepted.map((candidate) => ({
              id: randomUUID(),
              productId: product.id,
              provider: candidate.provider,
              candidateHash: createHash("sha256").update(candidate.mediaKind + "|" + candidate.landingPageUrl + "|" + (candidate.imageUrl ?? candidate.videoUrl ?? "")).digest("hex"),
              // Persist the canonical identity query used by the pending-candidate guard.
              query,
              title: candidate.title,
              mediaKind: candidate.mediaKind,
              imageUrl: candidate.imageUrl,
              videoUrl: candidate.videoUrl,
              landingPageUrl: candidate.landingPageUrl,
              creator: candidate.creator,
              creatorUrl: candidate.creatorUrl,
              license: candidate.license,
              licenseVersion: candidate.licenseVersion,
              licenseUrl: candidate.licenseUrl,
              sourcePublisher: candidate.sourcePublisher,
              identityScore: candidate.identityScore,
              identityStatus: candidate.identityStatus,
              identityReasons: candidate.identityReasons,
              reviewStatus: "pending" as const,
              rightsStatus: "unverified" as const,
              reviewedBy: null,
              reviewedAt: null,
              reviewReason: null,
              createdAt: now,
              updatedAt: now
            }));
            try {
              const saved = await this.catalogCandidates.saveMany(records);
              candidatesFound = accepted.length;
              catalogOutcome = accepted.length > 0 ? "success" : "no_results";
              const insertedCount = saved.length;
              const alreadyPresentCount = Math.max(0, accepted.length - insertedCount);
              console.info(JSON.stringify({
                event: "product_media_catalog_search_completed",
                provider: discoveryProvider,
                fallbackReason: openverseFailure ?? openverseFallbackReason,
                ...(openverseFailureDetails ? {
                  fallbackFailureDetails: {
                    endpoint: openverseFailureDetails.endpoint,
                    status: openverseFailureDetails.status,
                    contentType: openverseFailureDetails.contentType,
                    server: openverseFailureDetails.server,
                    cloudflareRayPresent: openverseFailureDetails.cloudflareRayPresent,
                    responseKind: openverseFailureDetails.responseKind
                  }
                } : {}),
                productId: product.id,
                resultCount: discovered.length,
                acceptedCount: accepted.length,
                savedCount: insertedCount,
                alreadyPresentCount
              }));
            } catch (error) {
              catalogOutcome = "provider_error";
              console.warn(JSON.stringify({
                event: "product_media_catalog_persistence_failed",
                provider: discoveryProvider,
                productId: product.id,
                acceptedCount: accepted.length,
                errorType: safeErrorType(error)
              }));
              skipped.push({
                url: discoveryProvider === "openverse" ? "https://api.openverse.org/v1/images/" : "https://commons.wikimedia.org/w/api.php",
                reason: "catalog_persistence_failed"
              });
            }
          }
          if (this.discoveryAttempts && claimed && leaseUntil) {
            const now = new Date();
            const cooldownMs = catalogOutcome === "success" ? 7 * 24 * 60 * 60_000
              : catalogOutcome === "no_results" ? 24 * 60 * 60_000
              : 30 * 60_000;
            try {
              await this.discoveryAttempts.complete({
                productId: product.id,
                fingerprint,
                leaseUntil,
                outcome: catalogOutcome,
                now: now.toISOString(),
                nextRetryAt: new Date(now.getTime() + cooldownMs).toISOString()
              });
            } catch (error) {
              console.warn(JSON.stringify({
                event: "product_media_discovery_cooldown_complete_failed",
                productId: product.id,
                errorType: safeErrorType(error)
              }));
            }
          }
        } else if (hasPendingCandidate) {
          skipped.push({ url: product.productUrl, reason: "catalog_discovery_skipped_pending_review" });
          console.info(JSON.stringify({
            event: "product_media_catalog_search_skipped_pending_review",
            productId: product.id
          }));
        } else if (!candidateLookupFailed && this.discoveryAttempts && !claimed) {
          console.info(JSON.stringify({ event: "product_media_catalog_search_skipped_cooldown", productId: product.id }));
        }
      }
      const catalogCandidates: ProductMediaCandidate[] = [];
      for (const candidate of [
        { kind: "video" as const, url: product.videoUrl },
        { kind: "image" as const, url: product.imageUrl }
      ]) {
        if (!candidate.url) continue;
        try {
          const mediaUrl = new URL(candidate.url);
          if (mediaUrl.protocol !== "https:" || mediaUrl.username || mediaUrl.password) {
            throw new Error("Explicit catalog media URLs must use credential-free HTTPS.");
          }
          if (isShopeeOwnedMediaHost(mediaUrl.hostname)) {
            skipped.push({ url: mediaUrl.toString(), reason: "Shopee-hosted media is not fetched automatically; upload a seller-authorized or self-created file instead." });
            continue;
          }
          const importedMedia = candidate.kind === "image"
            ? product.discoverySignals?.mediaImport?.image
            : product.discoverySignals?.mediaImport?.video;
          catalogCandidates.push({
            kind: candidate.kind,
            url: mediaUrl.toString(),
            source: "catalog",
            ...(importedMedia ? { importProvenance: {
              provider: importedMedia.source,
              ...(importedMedia.sourceReference ? { sourceReference: importedMedia.sourceReference } : {}),
              importedAt: importedMedia.importedAt
            } } : {})
          });
        } catch (error) {
          skipped.push({ url: candidate.url, reason: "Explicit catalog media URL could not be validated." });
        }
      }
      if (catalogCandidates.length > 0) {
        const ingested = await this.ingestion.ingest({
          productId: product.id,
          nonMediaEligibilityPassed: true,
          candidates: catalogCandidates
        });
        const stored = mergeStoredAssets(existing, ingested.stored);
        return {
          productId: product.id,
          pageFetched: false,
          hasVideo: stored.some((asset) => asset.bucket === this.bucketName && asset.kind === "video"),
          stored,
          skipped: [...skipped, ...ingested.skipped],
          candidatesFound
        };
      }
      skipped.push({ url: product.productUrl, reason: "Shopee product-page media extraction is disabled; only explicitly supplied catalog media can be ingested." });
      return { productId: product.id, pageFetched: false, hasVideo: false, stored: existing, skipped, candidatesFound };
    }

    // Persist a per-product cooldown for generic product-page discovery as well as
    // the Shopee catalog-search cooldown above. This prevents repeated external
    // page fetches when a product has no usable media, while changed product identity
    // invalidates the cooldown through the fingerprint.
    const pageFingerprint = createHash("sha256").update(JSON.stringify({
      name: product.name.trim(),
      category: product.category?.trim() ?? "",
      productUrl: pageUrl.toString(),
      imageUrl: product.imageUrl ?? "",
      videoUrl: product.videoUrl ?? ""
    })).digest("hex");
    let pageLeaseUntil: string | undefined;
    let pageClaimed = false;
    if (this.discoveryAttempts) {
      const now = new Date();
      pageLeaseUntil = new Date(now.getTime() + 15 * 60_000).toISOString();
      try {
        pageClaimed = await this.discoveryAttempts.claim({
          productId: product.id,
          fingerprint: pageFingerprint,
          now: now.toISOString(),
          leaseUntil: pageLeaseUntil
        });
      } catch (error) {
        skipped.push({ url: product.productUrl, reason: "product_page_discovery_cooldown_unavailable" });
        console.warn(JSON.stringify({
          event: "product_media_page_discovery_cooldown_claim_failed",
          productId: product.id,
          errorType: safeErrorType(error)
        }));
        return { productId: product.id, pageFetched: false, hasVideo: false, stored: existing, skipped };
      }
      if (!pageClaimed) {
        skipped.push({ url: product.productUrl, reason: "product_page_discovery_cooldown_active" });
        console.info(JSON.stringify({
          event: "product_media_page_discovery_skipped_cooldown",
          productId: product.id
        }));
        return { productId: product.id, pageFetched: false, hasVideo: false, stored: existing, skipped };
      }
    }
    const completePageAttempt = async (outcome: ProductMediaDiscoveryOutcome): Promise<void> => {
      if (!this.discoveryAttempts || !pageLeaseUntil || !pageClaimed) return;
      const now = new Date();
      const cooldownMs = outcome === "success" ? 7 * 24 * 60 * 60_000
        : outcome === "no_results" ? 24 * 60 * 60_000
        : 30 * 60_000;
      try {
        await this.discoveryAttempts.complete({
          productId: product.id,
          fingerprint: pageFingerprint,
          leaseUntil: pageLeaseUntil,
          outcome,
          now: now.toISOString(),
          nextRetryAt: new Date(now.getTime() + cooldownMs).toISOString()
        });
      } catch (error) {
        console.warn(JSON.stringify({
          event: "product_media_page_discovery_cooldown_complete_failed",
          productId: product.id,
          errorType: safeErrorType(error)
        }));
      }
    };

    let pageOutcome: ProductMediaDiscoveryOutcome = "provider_error";
    try {
      const page = await this.fetcher(pageUrl.toString(), {
        maxBytes: this.policy.maxProductPageBytes ?? 2_000_000,
        timeoutMs: this.policy.timeoutMs,
        maxRedirects: this.policy.maxRedirects,
        blockedHostnames: ["shopee.co.id", "shopee.com"]
      });
      const contentType = String(page.headers["content-type"] ?? "").toLowerCase();
      if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        pageOutcome = "no_results";
        await completePageAttempt(pageOutcome);
        return { productId: product.id, pageFetched: true, hasVideo: false, stored: existing, skipped: [{ url: page.url, reason: "Product page response is not HTML." }] };
      }
      const html = new TextDecoder().decode(page.bytes);
      const candidates = extractProductMediaCandidates(html, { pageUrl: page.url, maxCandidates: this.policy.maxCandidates ?? 30 });
      if (product.videoUrl) {
        try {
          const videoUrl = new URL(product.videoUrl);
          if (videoUrl.protocol === "https:" && !videoUrl.username && !videoUrl.password && !candidates.some((candidate) => candidate.kind === "video" && candidate.url === videoUrl.toString())) {
            candidates.unshift({ kind: "video", url: videoUrl.toString(), source: "html" });
          }
        } catch {
          skipped.push({ url: product.videoUrl, reason: "Existing product video URL is invalid." });
        }
      }
      if (!candidates.some((candidate) => candidate.kind === "video")) {
        skipped.push({ url: page.url, reason: "No public video candidate was found in product page metadata." });
      }
      const ingested = await this.ingestion.ingest({ productId: product.id, nonMediaEligibilityPassed: true, candidates });
      const stored = mergeStoredAssets(existing, ingested.stored);
      pageOutcome = candidates.length > 0 ? "success" : "no_results";
      await completePageAttempt(pageOutcome);
      return { productId: product.id, pageFetched: true, hasVideo: stored.some((asset) => asset.bucket === this.bucketName && asset.kind === "video"), stored, skipped: [...skipped, ...ingested.skipped] };
    } catch (error) {
      skipped.push({ url: pageUrl.toString(), reason: "product_page_discovery_failed:" + safeErrorType(error) });
      let fallbackStoredCount = 0;
      if (product.videoUrl) {
        try {
          const videoUrl = new URL(product.videoUrl);
          if (videoUrl.protocol === "https:" && !videoUrl.username && !videoUrl.password) {
            const fallback = await this.ingestion.ingest({ productId: product.id, nonMediaEligibilityPassed: true, candidates: [{ kind: "video", url: videoUrl.toString(), source: "html" }] });
            fallbackStoredCount = fallback.stored.length;
            skipped.push(...fallback.skipped);
          }
        } catch (fallbackError) {
          skipped.push({ url: product.videoUrl, reason: "fallback_video_ingestion_failed:" + safeErrorType(fallbackError) });
        }
      }
      const stored = await this.assets.listByProduct(product.id);
      pageOutcome = fallbackStoredCount > 0 ? "success" : "provider_error";
      await completePageAttempt(pageOutcome);
      return { productId: product.id, pageFetched: false, hasVideo: stored.some((asset) => asset.kind === "video"), stored, skipped };
    }
  }
}


function mergeStoredAssets(existing: ProductMediaAsset[], discovered: ProductMediaAsset[]): ProductMediaAsset[] {
  const byId = new Map<string, ProductMediaAsset>();
  for (const asset of [...existing, ...discovered]) byId.set(asset.id, asset);
  return [...byId.values()];
}
