import type { AffiliateOffer, Product } from "@affiliateos/shared";
import type { Repository } from "./repository.js";
import type { PreMediaEligibilityRepository } from "./pre-media-eligibility.js";
import {
  IllustrativeProductVideoRenderer,
  type IllustrativeProductVideoResult
} from "./illustrative-product-video-renderer.js";

export class IllustrativeProductVideoPreviewError extends Error {
  constructor(
    readonly code:
      | "PRODUCT_NOT_FOUND"
      | "PRODUCT_NOT_ACTIVE"
      | "PRE_MEDIA_ELIGIBILITY_REQUIRED"
      | "AFFILIATE_OFFER_NOT_ACTIVE"
      | "PRE_MEDIA_ELIGIBILITY_STALE",
    message: string
  ) {
    super(message);
    this.name = "IllustrativeProductVideoPreviewError";
  }
}

/**
 * Produces an ephemeral, review-only video for a currently eligible product.
 * It deliberately does not create content, persist media, call Storage, or
 * change publication rights. The publication pipeline remains independently gated.
 */
export class IllustrativeProductVideoPreviewService {
  constructor(
    private readonly products: Pick<Repository<Product>, "findById">,
    private readonly affiliateOffers: Pick<Repository<AffiliateOffer>, "findById">,
    private readonly eligibility: PreMediaEligibilityRepository,
    private readonly renderer = new IllustrativeProductVideoRenderer(),
    private readonly now: () => Date = () => new Date(),
    private readonly maxEvidenceAgeMs = 7 * 24 * 60 * 60_000
  ) {
    if (!Number.isSafeInteger(maxEvidenceAgeMs) || maxEvidenceAgeMs <= 0) {
      throw new Error("Illustrative preview evidence age must be a positive safe integer.");
    }
  }

  async render(productId: string): Promise<IllustrativeProductVideoResult> {
    const product = await this.products.findById(productId);
    if (!product) {
      throw new IllustrativeProductVideoPreviewError("PRODUCT_NOT_FOUND", "Produk tidak ditemukan.");
    }
    if (product.status !== "active") {
      throw new IllustrativeProductVideoPreviewError("PRODUCT_NOT_ACTIVE", "Produk tidak aktif dan tidak dapat dibuatkan preview promosi.");
    }

    const evidence = await this.eligibility.listLatestByProduct(productId, 50);
    const latestCreatedAt = evidence[0]?.createdAt;
    const latestTimestamp = latestCreatedAt ? Date.parse(latestCreatedAt) : Number.NaN;
    const nowTimestamp = this.now().getTime();
    if (!Number.isFinite(latestTimestamp) || latestTimestamp > nowTimestamp ||
        nowTimestamp - latestTimestamp > this.maxEvidenceAgeMs) {
      throw new IllustrativeProductVideoPreviewError("PRE_MEDIA_ELIGIBILITY_STALE", "Bukti seleksi produk tidak tersedia atau sudah kedaluwarsa; jalankan siklus seleksi terbaru terlebih dahulu.");
    }

    // One cycle writes multiple evidence rows with the same timestamp. Only
    // that newest evidence batch can authorize a preview; older approvals do not.
    const newestBatch = evidence.filter((row) => row.createdAt === latestCreatedAt);
    const eligibleOfferIds = [...new Set(newestBatch
      .filter((row) => row.eligible && row.offerId)
      .map((row) => row.offerId!))];
    if (eligibleOfferIds.length === 0) {
      throw new IllustrativeProductVideoPreviewError("PRE_MEDIA_ELIGIBILITY_REQUIRED", "Produk belum lolos seleksi non-media AffiliateOS.");
    }

    let activeOffer: AffiliateOffer | undefined;
    for (const offerId of eligibleOfferIds) {
      const offer = await this.affiliateOffers.findById(offerId);
      const expiresAt = offer?.affiliateLinkExpiresAt ? Date.parse(offer.affiliateLinkExpiresAt) : undefined;
      const linkHasValidExpiry = expiresAt === undefined || (Number.isFinite(expiresAt) && expiresAt > nowTimestamp);
      if (offer && offer.productId === productId && offer.status === "active" &&
          offer.affiliateLinkStatus === "active" && offer.availability !== "out_of_stock" && linkHasValidExpiry) {
        activeOffer = offer;
        break;
      }
    }
    if (!activeOffer) {
      throw new IllustrativeProductVideoPreviewError("AFFILIATE_OFFER_NOT_ACTIVE", "Penawaran afiliasi yang meloloskan produk sudah tidak aktif atau tautannya tidak tersedia.");
    }

    return this.renderer.render({
      productName: product.name,
      priceCents: product.priceCents,
      currency: product.currency
    });
  }
}
