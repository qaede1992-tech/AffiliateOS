import type { ContentPlatform, Product } from "@affiliateos/shared";
import { extractProductMediaCandidates, type ProductMediaCandidate } from "./product-media-discovery.js";
import { fetchPublicHttps } from "./public-https-fetch.js";
import type { ProductMediaIngestionPolicy, ProductMediaIngestionResult } from "./product-media-ingestion.js";
import { ProductMediaIngestionService } from "./product-media-ingestion.js";
import type { ProductMediaAssetRepository } from "./product-media-ingestion.js";
import type { SupabaseStorageClient } from "./supabase-storage.js";
import { ProductPromoVideoRenderer, type ProductPromoVideoRenderResult } from "./product-promo-video-renderer.js";
import { hasCurrentVerifiedRights } from "./product-media-publication-rights.js";
import { evaluateProductMediaAssetReadiness } from "./media-readiness-evaluator.js";
import { createHash, randomUUID } from "node:crypto";
import { buildProductMediaSearchQuery, getOpenverseHttpFailureDetails, searchOpenverseProductMedia, type ProductMediaCatalogCandidate, type ProductMediaCatalogSearchOptions } from "./product-media-catalog-search.js";
import { searchWikimediaCommonsProductMedia } from "./product-media-wikimedia-search.js";
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
      if (this.catalogCandidates) {
        const identity = { name: product.name, ...(product.category?.trim() ? { category: product.category } : {}) };
        const query = buildProductMediaSearchQuery(identity);
        const fingerprint = createHash("sha256").update(JSON.stringify({
          name: product.name.trim(),
          category: product.category?.trim() ?? "",
          productUrl: product.productUrl,
          imageUrl: product.imageUrl ?? "",
          videoUrl: product.videoUrl ?? "",
          query
        })).digest("hex");
        let shouldSearch = true;
        let claimed = false;
        let leaseUntil: string | undefined;
        let catalogOutcome: ProductMediaDiscoveryOutcome = "no_results";
        if (this.discoveryAttempts) {
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
          let discoveryFailed = false;
          try {
            try {
              discovered = await searchOpenverseProductMedia(identity, { ...this.catalogSearchOptions, maxResults: 10 });
            } catch (error) {
              openverseFailure = safeErrorType(error);
              openverseFailureDetails = getOpenverseHttpFailureDetails(error);
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
              candidateHash: createHash("sha256").update(candidate.landingPageUrl + "|" + candidate.imageUrl).digest("hex"),
              query: candidate.searchQuery ?? query,
              title: candidate.title,
              imageUrl: candidate.imageUrl,
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
                fallbackReason: openverseFailure,
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
        } else if (this.discoveryAttempts && !claimed) {
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
          catalogCandidates.push({ kind: candidate.kind, url: mediaUrl.toString(), source: "catalog" });
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
        const stored = await this.assets.listByProduct(product.id);
        return {
          productId: product.id,
          pageFetched: false,
          hasVideo: stored.some((asset) => asset.kind === "video"),
          stored,
          skipped: [...skipped, ...ingested.skipped],
          candidatesFound
        };
      }
      skipped.push({ url: product.productUrl, reason: "Shopee product-page media extraction is disabled; only explicitly supplied catalog media can be ingested." });
      return { productId: product.id, pageFetched: false, hasVideo: false, stored: existing, skipped, candidatesFound };
    }

    try {
      const page = await this.fetcher(pageUrl.toString(), {
        maxBytes: this.policy.maxProductPageBytes ?? 2_000_000,
        timeoutMs: this.policy.timeoutMs,
        maxRedirects: this.policy.maxRedirects,
        blockedHostnames: ["shopee.co.id", "shopee.com"]
      });
      const contentType = String(page.headers["content-type"] ?? "").toLowerCase();
      if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
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
      const stored = await this.assets.listByProduct(product.id);
      return { productId: product.id, pageFetched: true, hasVideo: stored.some((asset) => asset.kind === "video"), stored: ingested.stored, skipped: [...skipped, ...ingested.skipped] };
    } catch (error) {
      skipped.push({ url: pageUrl.toString(), reason: "product_page_discovery_failed:" + safeErrorType(error) });
      if (product.videoUrl) {
        try {
          const videoUrl = new URL(product.videoUrl);
          if (videoUrl.protocol === "https:" && !videoUrl.username && !videoUrl.password) {
            const fallback = await this.ingestion.ingest({ productId: product.id, nonMediaEligibilityPassed: true, candidates: [{ kind: "video", url: videoUrl.toString(), source: "html" }] });
            skipped.push(...fallback.skipped);
          }
        } catch (fallbackError) {
          skipped.push({ url: product.videoUrl, reason: "fallback_video_ingestion_failed:" + safeErrorType(fallbackError) });
        }
      }
      const stored = await this.assets.listByProduct(product.id);
      return { productId: product.id, pageFetched: false, hasVideo: stored.some((asset) => asset.kind === "video"), stored, skipped };
    }
  }
}
