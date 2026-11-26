import type { AffiliateOffer, Product, Content } from "@affiliateos/shared";
import type { Repository } from "./repository.js";
import type { PreMediaEligibilityRepository } from "./pre-media-eligibility.js";
import { IllustrativeProductVideoRenderer } from "./illustrative-product-video-renderer.js";
import type { IllustrativeCreativeFileStore } from "./illustrative-creative-file-store.js";
import type { IllustrativeCreativeRecord } from "./illustrative-media-delivery.js";

export interface IllustrativeCreativePersistence {
  createPending(input: {
    id: string; contentId: string; productId: string; affiliateOfferId: string;
    rendererVersion: string; templateVersion: string; sha256: string;
    productSnapshot: Record<string, unknown>; mimeType: "video/mp4";
    byteSize: number; widthPx: number; heightPx: number; durationMs: number;
    storageKey: string; disclosureEmbedded: true;
  }): Promise<IllustrativeCreativeRecord>;
}

export class IllustrativeProductCreativeGenerationService {
  constructor(private readonly dependencies: {
    products: Pick<Repository<Product>, "findById">;
    contents: Pick<Repository<Content>, "findById">;
    offers: Pick<Repository<AffiliateOffer>, "findById">;
    eligibility: PreMediaEligibilityRepository;
    creatives: IllustrativeCreativePersistence;
    files: IllustrativeCreativeFileStore;
    renderer?: IllustrativeProductVideoRenderer;
    now?: () => Date;
    maxEvidenceAgeMs?: number;
  }) {}

  async generate(input: { productId: string; contentId: string }): Promise<IllustrativeCreativeRecord> {
    const product = await this.dependencies.products.findById(input.productId);
    if (!product || product.status !== "active") throw new Error("An active selected product is required.");
    const content = await this.dependencies.contents.findById(input.contentId);
    if (!content || content.productId !== product.id || content.platform !== "instagram" ||
        content.contentType !== "affiliate-promotion" || content.status !== "draft") {
      throw new Error("A draft Instagram affiliate-promotion for the selected product is required.");
    }

    const now = (this.dependencies.now ?? (() => new Date()))().getTime();
    const maxAge = this.dependencies.maxEvidenceAgeMs ?? 7 * 24 * 60 * 60_000;
    const evidence = await this.dependencies.eligibility.listLatestByProduct(product.id, 50);
    const latestCreatedAt = evidence[0]?.createdAt;
    const latestTimestamp = latestCreatedAt ? Date.parse(latestCreatedAt) : Number.NaN;
    if (!Number.isFinite(latestTimestamp) || latestTimestamp > now || now - latestTimestamp > maxAge) {
      throw new Error("Fresh non-media product eligibility evidence is required before generating creative.");
    }

    const eligibleOfferIds = [...new Set(evidence
      .filter((row) => row.createdAt === latestCreatedAt && row.eligible && row.offerId)
      .map((row) => row.offerId!))];
    let selectedOffer: AffiliateOffer | undefined;
    for (const offerId of eligibleOfferIds) {
      const offer = await this.dependencies.offers.findById(offerId);
      const expiry = offer?.affiliateLinkExpiresAt ? Date.parse(offer.affiliateLinkExpiresAt) : undefined;
      if (offer && offer.productId === product.id && offer.status === "active" &&
          offer.affiliateLinkStatus === "active" && offer.availability !== "out_of_stock" &&
          (expiry === undefined || (Number.isFinite(expiry) && expiry > now))) {
        selectedOffer = offer;
        break;
      }
    }
    if (!selectedOffer) throw new Error("No currently active affiliate offer from the latest eligible selection exists.");

    const renderer = this.dependencies.renderer ?? new IllustrativeProductVideoRenderer();
    const rendered = await renderer.render({
      productName: product.name, priceCents: product.priceCents, currency: product.currency
    });
    const creativeId = crypto.randomUUID();
    const stored = await this.dependencies.files.put({
      creativeId, bytes: rendered.bytes, expectedSha256: rendered.metadata.sha256
    });
    try {
      return await this.dependencies.creatives.createPending({
        id: creativeId, contentId: content.id, productId: product.id,
        affiliateOfferId: selectedOffer.id,
        rendererVersion: "illustrative-product-video-renderer-v1",
        templateVersion: "text-led-promo-v1",
        sha256: rendered.metadata.sha256,
        productSnapshot: {
          id: product.id, name: product.name, priceCents: product.priceCents,
          currency: product.currency, status: product.status
        },
        mimeType: "video/mp4", byteSize: rendered.metadata.byteSize,
        widthPx: rendered.metadata.width, heightPx: rendered.metadata.height,
        durationMs: rendered.metadata.durationMs, storageKey: stored.key,
        disclosureEmbedded: true
      });
    } catch (error) {
      try { await this.dependencies.files.remove(stored.key); } catch { /* Preserve the persistence error; orphan cleanup is handled operationally. */ }
      throw error;
    }
  }
}
