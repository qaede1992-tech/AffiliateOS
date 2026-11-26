import { createHash } from "node:crypto";
import type { Content, CampaignOffer, TrackingLink } from "@affiliateos/shared";
import { isExplicitlyAffiliateEligible } from "./opportunity-scoring.js";
import type { MediaAsset } from "./media-asset.js";
import type { PreMediaEligibilityRepository } from "./pre-media-eligibility.js";
import type { ProductCatalogRepository, AffiliateOfferRepository, CampaignOfferRepository, TrackingLinkRepository } from "./repository.js";
import type { IllustrativeCreativeRecord } from "./illustrative-media-delivery.js";

export type IllustrativeCreativePolicy = {
  platform: "instagram";
  enabled: boolean;
  policyVersion: string;
  approvedBy: string | null;
  approvedAt: string | null;
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
function fail(reason: string): never { throw new Error(`ILLUSTRATIVE_CREATIVE_PUBLICATION_BLOCKED: ${reason}`); }

const allowedVersions = (terms: Record<string, unknown>, key: string): string[] => {
  const value = terms[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
};

type ProductSnapshot = { productId: string; name: string; priceCents: number; currency: string; capturedAt: string };


export type IllustrativeCreativeProvenanceSnapshot = {
  policy: {
    platform: "instagram";
    enabled: boolean;
    policyVersion: string;
    approvedBy: string | null;
    approvedAt: string | null;
    terms: Record<string, unknown>;
  };
  creatives: Array<Record<string, unknown>>;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
};

export const hashIllustrativeCreativeProvenanceSnapshot = (snapshot: IllustrativeCreativeProvenanceSnapshot | null): string =>
  createHash("sha256").update(JSON.stringify(canonicalize(snapshot)) ?? "null").digest("hex");

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


  /**
   * Captures every publication-relevant generated-creative field after validation.
   * This snapshot is persisted in the dispatch reservation and compared again
   * immediately before Instagram's final media_publish call.
   */
  async createProvenanceSnapshot(mediaAssets: MediaAsset[], generatedIds: ReadonlySet<string>): Promise<IllustrativeCreativeProvenanceSnapshot | null> {
    if (generatedIds.size === 0) return null;
    const policy = await this.dependencies.creatives.getPolicy("instagram");
    if (!policy) fail("Instagram illustrative creative policy record is missing");
    const creatives: Array<Record<string, unknown>> = [];
    for (const media of mediaAssets.filter((asset) => generatedIds.has(asset.id)).sort((a, b) => a.id.localeCompare(b.id))) {
      const creative = await this.dependencies.creatives.findByMediaAssetId(media.id);
      if (!creative || creative.mediaAssetId !== media.id) fail("generated creative provenance changed while snapshotting");
      creatives.push({
        id: creative.id,
        mediaAssetId: creative.mediaAssetId,
        contentId: creative.contentId,
        productId: creative.productId ?? null,
        affiliateOfferId: creative.affiliateOfferId ?? null,
        platform: creative.platform,
        rendererVersion: creative.rendererVersion ?? null,
        templateVersion: creative.templateVersion ?? null,
        sha256: creative.sha256,
        mimeType: creative.mimeType,
        byteSize: creative.byteSize,
        widthPx: creative.widthPx ?? null,
        heightPx: creative.heightPx ?? null,
        durationMs: creative.durationMs ?? null,
        disclosureEmbedded: creative.disclosureEmbedded,
        storageBackend: creative.storageBackend,
        storageKey: creative.storageKey,
        reviewStatus: creative.reviewStatus,
        reviewedBy: creative.reviewedBy ?? null,
        reviewedAt: creative.reviewedAt ?? null,
        reviewReason: creative.reviewReason ?? null,
        productSnapshot: creative.productSnapshot ?? null
      });
    }
    if (creatives.length !== generatedIds.size) fail("not every generated media ID has a persisted creative provenance record");
    return {
      policy: {
        platform: policy.platform,
        enabled: policy.enabled,
        policyVersion: policy.policyVersion,
        approvedBy: policy.approvedBy,
        approvedAt: policy.approvedAt,
        terms: policy.terms
      },
      creatives
    };
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
    const referenceFilename = objectKey.slice(objectKey.lastIndexOf("/") + 1);
    if (referenceFilename !== creative.storageKey) {
      fail("media asset reference filename does not match the creative storage key");
    }

    const policy = await this.dependencies.creatives.getPolicy("instagram");
    if (!policy || policy.enabled !== true || policy.platform !== "instagram") {
      fail("Instagram illustrative creative policy is disabled");
    }
    const rendererVersion = creative.rendererVersion;
    const templateVersion = creative.templateVersion;
    if (typeof rendererVersion !== "string" || typeof templateVersion !== "string" ||
        !allowedVersions(policy.terms, "allowedRendererVersions").includes(rendererVersion) ||
        !allowedVersions(policy.terms, "allowedTemplateVersions").includes(templateVersion)) {
      fail("renderer or template version is not allow-listed by the active policy");
    }

    const productId = creative.productId;
    if (typeof productId !== "string" || !productId) fail("the creative has no linked product");
    const product = await this.dependencies.products.findById(productId);
    if (!product || product.status !== "active") fail("the linked product is missing or inactive");
    const snapshot = creative.productSnapshot as Partial<ProductSnapshot>;
    const capturedAt = typeof snapshot.capturedAt === "string" ? Date.parse(snapshot.capturedAt) : Number.NaN;
    if (snapshot.productId !== product.id || snapshot.name !== product.name ||
        snapshot.priceCents !== product.priceCents || snapshot.currency !== product.currency ||
        !Number.isFinite(capturedAt) || capturedAt > now.getTime() ||
        now.getTime() - capturedAt > MAX_EVIDENCE_AGE_MS) {
      fail("rendered product facts are stale or no longer match the current product");
    }

    const affiliateOfferId = creative.affiliateOfferId;
    if (typeof affiliateOfferId !== "string" || !affiliateOfferId) fail("the creative has no exact affiliate offer");
    const offer = await this.dependencies.offers.findById(affiliateOfferId);
    if (!offer || offer.productId !== product.id || offer.status !== "active" ||
        offer.availability === "out_of_stock" || offer.affiliateLinkStatus !== "active" ||
        !offer.affiliateUrl || !isExplicitlyAffiliateEligible(offer)) {
      fail("the exact affiliate offer is no longer active and eligible");
    }
    if (offer.affiliateLinkExpiresAt) {
      const expiresAt = Date.parse(offer.affiliateLinkExpiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) fail("the affiliate link has expired");
    }
    const campaignId = content.campaignId;
    if (!campaignId) fail("affiliate promotion content has no campaign");
    const campaignOffers = await this.dependencies.campaignOffers.listByCampaign(campaignId);
    if (!campaignOffers.some((attachment: CampaignOffer) => attachment.affiliateOfferId === offer.id)) {
      fail("the creative affiliate offer is not attached to the publishing campaign");
    }
    const trackingLinks = await this.dependencies.trackingLinks.listByCampaign(campaignId);
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

    const storageKey = creative.storageKey;
    if (typeof storageKey !== "string" || !storageKey) fail("creative has no local storage key");
    try {
      await this.dependencies.files.get({
        key: storageKey, expectedSha256: creative.sha256, expectedByteSize: creative.byteSize
      });
    } catch {
      fail("local creative file is missing or failed integrity verification");
    }
  }
}
