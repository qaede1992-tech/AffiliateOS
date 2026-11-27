import type { AffiliateOffer, Product } from "@affiliateos/shared";
import type { PreMediaEligibilityRepository } from "./pre-media-eligibility.js";
import type { ProductMediaDiscoveryResult, ProductMediaDiscoveryRunner } from "./product-media-discovery-runner.js";

export class ProductMediaDiscoveryError extends Error {
  constructor(
    readonly code: "PRODUCT_MEDIA_DISCOVERY_PRODUCT_NOT_FOUND" | "PRODUCT_MEDIA_DISCOVERY_PRODUCT_INACTIVE" | "PRODUCT_MEDIA_DISCOVERY_NOT_SHOPEE" | "PRODUCT_MEDIA_DISCOVERY_ELIGIBILITY_REQUIRED" | "PRODUCT_MEDIA_DISCOVERY_OFFER_UNAVAILABLE",
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "ProductMediaDiscoveryError";
  }
}

export interface ProductMediaDiscoveryServiceDependencies {
  runner: Pick<ProductMediaDiscoveryRunner, "discover">;
  preMediaEligibility: Pick<PreMediaEligibilityRepository, "listLatestByProduct">;
  findProductById(productId: string): Promise<Product | undefined>;
  findAffiliateOfferById(offerId: string): Promise<AffiliateOffer | undefined>;
  now?: () => Date;
  eligibilityMaxAgeMs?: number;
}

const isShopeeProductUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return url.protocol === "https:" && !url.username && !url.password &&
      (hostname === "shopee.co.id" || hostname.endsWith(".shopee.co.id") ||
       hostname === "shopee.com" || hostname.endsWith(".shopee.com"));
  } catch {
    return false;
  }
};

const hasUsableAffiliateLink = (offer: AffiliateOffer, productId: string, now: Date): boolean => {
  if (offer.productId !== productId || offer.status !== "active" ||
      offer.affiliateLinkStatus !== "active" || !offer.affiliateUrl) return false;
  const metadata = offer.availabilityMetadata ?? {};
  if (["affiliateEligible", "commissionEligible", "isEligible"].some((key) => metadata[key] === false)) return false;
  try {
    const url = new URL(offer.affiliateUrl);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return false;
  } catch {
    return false;
  }
  if (!offer.affiliateLinkExpiresAt) return true;
  const expiresAt = Date.parse(offer.affiliateLinkExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
};

/** Runs catalog discovery for one Shopee product using persisted eligibility only. */
export class ProductMediaDiscoveryService {
  private readonly now: () => Date;
  private readonly eligibilityMaxAgeMs: number;

  constructor(private readonly dependencies: ProductMediaDiscoveryServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.eligibilityMaxAgeMs = dependencies.eligibilityMaxAgeMs ?? 24 * 60 * 60 * 1000;
  }

  async discoverShopeeProductMedia(productId: string): Promise<ProductMediaDiscoveryResult> {
    const product = await this.dependencies.findProductById(productId);
    if (!product) throw new ProductMediaDiscoveryError("PRODUCT_MEDIA_DISCOVERY_PRODUCT_NOT_FOUND", "Product was not found.", 404);
    if (product.status !== "active") throw new ProductMediaDiscoveryError("PRODUCT_MEDIA_DISCOVERY_PRODUCT_INACTIVE", "Only active products can be searched.", 409);
    if (!isShopeeProductUrl(product.productUrl)) {
      throw new ProductMediaDiscoveryError("PRODUCT_MEDIA_DISCOVERY_NOT_SHOPEE", "This endpoint only accepts Shopee product URLs.", 400);
    }

    const now = this.now();
    const evidence = (await this.dependencies.preMediaEligibility.listLatestByProduct(productId, 1))[0];
    const evidenceAge = evidence ? now.getTime() - Date.parse(evidence.createdAt) : Number.POSITIVE_INFINITY;
    if (!evidence || evidence.eligible !== true || evidence.productId !== product.id ||
        evidence.marketplaceId !== product.marketplaceId || !evidence.offerId ||
        !Number.isFinite(evidenceAge) || evidenceAge < 0 || evidenceAge > this.eligibilityMaxAgeMs) {
      throw new ProductMediaDiscoveryError(
        "PRODUCT_MEDIA_DISCOVERY_ELIGIBILITY_REQUIRED",
        "A recent, successful non-media eligibility record for this exact product is required before media discovery.",
        409
      );
    }

    const offer = await this.dependencies.findAffiliateOfferById(evidence.offerId);
    if (!offer || !hasUsableAffiliateLink(offer, product.id, now)) {
      throw new ProductMediaDiscoveryError(
        "PRODUCT_MEDIA_DISCOVERY_OFFER_UNAVAILABLE",
        "The affiliate offer attached to the latest eligibility record is no longer active or usable.",
        409
      );
    }

    return this.dependencies.runner.discover(product, true);
  }
}
