import type { Product } from "@affiliateos/shared";
import { extractProductMediaCandidates } from "./product-media-discovery.js";
import { fetchPublicHttps } from "./public-https-fetch.js";
import type { ProductMediaIngestionPolicy, ProductMediaIngestionResult } from "./product-media-ingestion.js";
import { ProductMediaIngestionService } from "./product-media-ingestion.js";
import type { ProductMediaAssetRepository } from "./product-media-ingestion.js";
import type { SupabaseStorageClient } from "./supabase-storage.js";

export interface ProductMediaDiscoveryPolicy extends ProductMediaIngestionPolicy {
  maxProductPageBytes?: number;
  maxCandidates?: number;
}

export interface ProductMediaDiscoveryResult extends ProductMediaIngestionResult {
  productId: string;
  pageFetched: boolean;
  hasVideo: boolean;
}

const isShopeeHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "shopee.co.id" || host.endsWith(".shopee.co.id") ||
    host === "shopee.com" || host.endsWith(".shopee.com");
};

/**
 * Discovers public product media only after the caller has selected a candidate
 * using non-media affiliate criteria. It does not bypass login, CAPTCHA, or bot
 * protections. Shopee product pages are deliberately excluded from HTML extraction;
 * only media URLs explicitly supplied in the catalog may be ingested for Shopee.
 */
export class ProductMediaDiscoveryRunner {
  private readonly ingestion: ProductMediaIngestionService;

  constructor(
    storage: SupabaseStorageClient,
    private readonly assets: ProductMediaAssetRepository,
    private readonly policy: ProductMediaDiscoveryPolicy,
    private readonly fetcher: typeof fetchPublicHttps = fetchPublicHttps
  ) {
    this.ingestion = new ProductMediaIngestionService(storage, assets, policy, fetcher);
  }

  async hasStoredVideo(productId: string): Promise<boolean> {
    return (await this.assets.listByProduct(productId)).some((asset) => asset.kind === "video");
  }

  async listVideoProductIds(productIds: string[]): Promise<string[]> {
    const result: string[] = [];
    for (const productId of [...new Set(productIds)]) {
      if (await this.hasStoredVideo(productId)) result.push(productId);
    }
    return result;
  }

  async discover(product: Product, nonMediaEligibilityPassed: boolean): Promise<ProductMediaDiscoveryResult> {
    const skipped: Array<{ url: string; reason: string }> = [];
    if (!nonMediaEligibilityPassed) {
      throw new Error("Product must pass non-media affiliate eligibility before discovery.");
    }
    const existing = await this.assets.listByProduct(product.id);
    if (existing.some((asset) => asset.kind === "video")) {
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
      if (product.videoUrl) {
        try {
          const videoUrl = new URL(product.videoUrl);
          if (videoUrl.protocol === "https:" && !videoUrl.username && !videoUrl.password) {
            const ingested = await this.ingestion.ingest({
              productId: product.id,
              nonMediaEligibilityPassed: true,
              candidates: [{ kind: "video", url: videoUrl.toString(), source: "html" }]
            });
            const stored = await this.assets.listByProduct(product.id);
            return {
              productId: product.id, pageFetched: false,
              hasVideo: stored.some((asset) => asset.kind === "video"),
              stored: ingested.stored, skipped: ingested.skipped
            };
          }
        } catch (error) {
          skipped.push({ url: product.videoUrl, reason: error instanceof Error ? error.message : "Explicit product video URL could not be validated." });
        }
      }
      skipped.push({ url: product.productUrl, reason: "Shopee product-page media extraction is disabled; only explicitly supplied catalog media can be ingested." });
      return { productId: product.id, pageFetched: false, hasVideo: false, stored: existing, skipped };
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
      skipped.push({ url: pageUrl.toString(), reason: error instanceof Error ? error.message : "Product page discovery failed." });
      if (product.videoUrl) {
        try {
          const videoUrl = new URL(product.videoUrl);
          if (videoUrl.protocol === "https:" && !videoUrl.username && !videoUrl.password) {
            const fallback = await this.ingestion.ingest({ productId: product.id, nonMediaEligibilityPassed: true, candidates: [{ kind: "video", url: videoUrl.toString(), source: "html" }] });
            skipped.push(...fallback.skipped);
          }
        } catch (fallbackError) {
          skipped.push({ url: product.videoUrl, reason: fallbackError instanceof Error ? fallbackError.message : "Existing product video could not be validated." });
        }
      }
      const stored = await this.assets.listByProduct(product.id);
      return { productId: product.id, pageFetched: false, hasVideo: stored.some((asset) => asset.kind === "video"), stored, skipped };
    }
  }
}
