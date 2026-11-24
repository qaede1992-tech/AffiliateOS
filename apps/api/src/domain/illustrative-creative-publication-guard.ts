import type { Content, CampaignOffer, TrackingLink } from "@affiliateos/shared";
import { isExplicitlyAffiliateEligible } from "./opportunity-scoring.js";
import type { MediaAsset } from "./media-asset.js";
import type { PreMediaEligibilityRepository } from "./pre-media-eligibility.js";
import type { ProductCatalogRepository, AffiliateOfferRepository, CampaignOfferRepository, TrackingLinkRepository } from "./repository.js";
import type { IllustrativeCreativeRecord } from "./illustrative-media-delivery.js";

export type IllustrativeCreativePolicy = {
  platform: "instagram";
  enabled: boolean;
  terms: Record<string, unknown>;
};
export interface IllustrativeCreativePublicationRepository {
  findByMediaAssetId(mediaAssetId: string): Promise<IllustrativeCreativeRecord | undefined>;
  getPolicy(platform: "instagram"): Promise<IllustrativeCreativePolicy | undefined>;
}
export interface IllustrativeCreativeIntegrityReader {
  get(input: { key: string; expectedSha256: string; expectedByteSize: number }): Promise<Uint8Array>;
}

export type IllustrativePublicationGuardDependencies = {
  creatives: IllustrativeCreativePublicationRepository;
  files: IllustrativeCreativeIntegrityReader;
  products: ProductCatalogRepository;
  offers: AffiliateOfferRepository;
  campaignOffers: CampaignOfferRepository;
  trackingLinks: TrackingLinkRepository;
  preMediaEligibility: PreMediaEligibilityRepository;
};

const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;
const STORAGE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[a-f0-9]{64}\.mp4$/i;
const fail = (reason: string): never => { throw new Error(`ILLUSTRATIVE_CREATIVE_PUBLICATION_BLOCKED: ${reason}`); };

const allowedVersions = (terms: Record<string, unknown>, key: string): string[] => {
  const value = terms[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
};

type ProductSnapshot = { productId: string; name: string; priceCents: number; currency: string; capturedAt: string };

export class IllustrativeCreativePublicationGuard {
  constructor(private readonly dependencies: IllustrativePublicationGuardDependencies) {}

  /**
   * Validate every generated creative found among the content media assets.
   * Missing provenance is not treated as generated media; the caller must still
   * send all remaining assets through the existing third-party rights gate.
   */
  async validate(input: {
    content: Content;
    mediaAssets: MediaAsset[];
    linkedProductIds: string[];
    now?: Date;
  }): Promise<Set<string>> {
    const generatedIds = new Set<string>();
    const now = input.now ?? new Date();
    for (const media of input.mediaAssets) {
      const creative = await this.dependencies.creatives.findByMediaAssetId(media.id);
      if (!creative) continue;
      await this.validateOne({ content: input.content, media, creative, linkedProductIds: input.linkedProductIds, now });
      generatedIds.add(media.id);
    }
    return generatedIds;
  }

  private async validateOne(input: {
    content: Content;
    media: MediaAsset;
    creative: IllustrativeCreativeRecord;
    linkedProductIds: string[];
    now: Date;
  }): Promise<void> {
    const { content, media, creative, linkedProductIds, now } = input;
    if (content.platform !== "instagram" || content.contentType !== "affiliate-promotion" || !content.campaignId) {
      fail("creative is not attached to scheduled Instagram affiliate-promotion content");
    }
    if (creative.platform !== "instagram" || creative.contentId !== content.id ||
        creative.mediaAssetId !== media.id || !content.mediaAssetIds?.includes(media.id)) {
      fail("creative, media asset, and content identity do not match");
    }
    if (!creative.productId || !linkedProductIds.includes(creative.productId) ||
        (content.productId && content.productId !== creative.productId)) {
      fail("creative product is not linked to the publishing content");
    }
    if (!creative.affiliateOfferId) fail("creative has no exact affiliate offer reference");
    if (creative.reviewStatus !== "approved" || !creative.disclosureEmbedded) {
      fail("creative is not approved or the mandatory disclosure is missing");
    }
    if (creative.mimeType !== "video/mp4" || creative.widthPx !== 720 ||
        creative.heightPx !== 1280 || creative.durationMs !== 12_000 ||
        !Number.isSafeInteger(creative.byteSize) || creative.byteSize <= 0 || !SHA256.test(creative.sha256)) {
      fail("creative media metadata is outside the approved renderer output contract");
    }
    if (creative.storageBackend !== "local_volume" || !creative.storageKey || !STORAGE_KEY.test(creative.storageKey)) {
      fail("creative does not reference an opaque local-volume file key");
    }
    if (media.contentId !== content.id || media.kind !== "video" || media.source !== "object-storage" ||
        media.mimeType !== "video/mp4" || media.byteSize !== creative.byteSize ||
        media.widthPx !== 720 || media.heightPx !== 1280 || media.durationSeconds !== 12) {
      fail("media asset metadata does not match the generated creative");
    }
    const separator = media.reference.indexOf("/");
    const objectKey = separator > 0 ? media.reference.slice(separator + 1) : "";
    if (!objectKey.startsWith(`content/${content.id}/`) ||
        objectKey.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
      fail("media asset reference is outside the content-scoped identity namespace");
    }

    const policy = await this.dependencies.creatives.getPolicy("instagram");
    if (!policy?.enabled || policy.platform !== "instagram") fail("Instagram illustrative creative policy is disabled");
    if (!allowedVersions(policy.terms, "allowedRendererVersions").includes(creative.rendererVersion) ||
        !allowedVersions(policy.terms, "allowedTemplateVersions").includes(creative.templateVersion)) {
      fail("renderer or template version is not allow-listed by the active policy");
    }

    const product = await this.dependencies.products.findById(creative.productId);
    if (!product || product.status !== "active") fail("the linked product is missing or inactive");
    const snapshot = creative.productSnapshot as Partial<ProductSnapshot>;
    const capturedAt = typeof snapshot.capturedAt === "string" ? Date.parse(snapshot.capturedAt) : Number.NaN;
    if (snapshot.productId !== product.id || snapshot.name !== product.name ||
        snapshot.priceCents !== product.priceCents || snapshot.currency !== product.currency ||
        !Number.isFinite(capturedAt) || capturedAt > now.getTime() ||
        now.getTime() - capturedAt > MAX_EVIDENCE_AGE_MS) {
      fail("rendered product facts are stale or no longer match the current product");
    }

    const offer = await this.dependencies.offers.findById(creative.affiliateOfferId);
    if (!offer || offer.productId !== product.id || offer.status !== "active" ||
        offer.availability === "out_of_stock" || offer.affiliateLinkStatus !== "active" ||
        !offer.affiliateUrl || !isExplicitlyAffiliateEligible(offer)) {
      fail("the exact affiliate offer is no longer active and eligible");
    }
    if (offer.affiliateLinkExpiresAt) {
      const expiresAt = Date.parse(offer.affiliateLinkExpiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) fail("the affiliate link has expired");
    }
    const campaignOffers = await this.dependencies.campaignOffers.listByCampaign(content.campaignId);
    if (!campaignOffers.some((attachment: CampaignOffer) => attachment.affiliateOfferId === offer.id)) {
      fail("the creative affiliate offer is not attached to the publishing campaign");
    }
    const trackingLinks = await this.dependencies.trackingLinks.listByCampaign(content.campaignId);
    if (!trackingLinks.some((link: TrackingLink) =>
      link.status === "active" && link.affiliateOfferId === offer.id && link.destinationUrl === offer.affiliateUrl
    )) fail("the exact affiliate offer has no matching active tracking link");

    const evidence = await this.dependencies.preMediaEligibility.listLatestByProduct(product.id, 1);
    const latest = evidence[0];
    const evidenceAt = latest ? Date.parse(latest.createdAt) : Number.NaN;
    if (!latest || !latest.eligible || latest.offerId !== offer.id ||
        !Number.isFinite(evidenceAt) || evidenceAt > now.getTime() ||
        now.getTime() - evidenceAt > MAX_EVIDENCE_AGE_MS) {
      fail("the latest pre-media eligibility evidence is missing, negative, stale, or for another offer");
    }

    try {
      await this.dependencies.files.get({
        key: creative.storageKey, expectedSha256: creative.sha256, expectedByteSize: creative.byteSize
      });
    } catch {
      fail("local creative file is missing or failed integrity verification");
    }
  }
}
