import { randomUUID } from "node:crypto";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "./product-media-ingestion.js";
import type { SupabaseStorageClient } from "./supabase-storage.js";
import type { IllustrativeProductVideoPreviewService } from "./illustrative-product-video-preview.js";

export interface IllustrativeProductVideoAssetResult {
  generated: boolean;
  asset: ProductMediaAsset;
  reason?: string;
}

/**
 * Persists the text-led illustrative preview as a product-scoped media asset.
 * It is intentionally marked rights-unverified and is never publication-ready
 * until the existing rights review workflow approves it.
 */
export class IllustrativeProductVideoAssetService {
  constructor(
    private readonly preview: IllustrativeProductVideoPreviewService,
    private readonly storage: SupabaseStorageClient,
    private readonly assets: ProductMediaAssetRepository
  ) {}

  async generate(productId: string): Promise<IllustrativeProductVideoAssetResult> {
    const sourceUrl = "generated:affiliateos-illustrative-video:v1";
    const existing = await this.assets.findByProductAndSourceUrl?.(productId, sourceUrl, "video");
    if (existing) {
      return { generated: false, asset: existing, reason: "An illustrative video asset already exists for this product." };
    }

    const rendered = await this.preview.render(productId);
    const sha256 = rendered.metadata.sha256;
    const duplicate = await this.assets.findByProductAndHash(productId, sha256);
    if (duplicate) {
      return { generated: false, asset: duplicate, reason: "An identical media asset already exists for this product." };
    }

    const id = randomUUID();
    const objectKey = `products/${productId}/illustrative-${sha256}-${id}.mp4`;
    const stored = await this.storage.upload({
      key: objectKey,
      bytes: rendered.bytes,
      contentType: "video/mp4",
      upsert: false
    });
    const asset: ProductMediaAsset = {
      id,
      productId,
      kind: "video",
      bucket: stored.bucket,
      objectKey: stored.key,
      mimeType: "video/mp4",
      byteSize: rendered.metadata.byteSize,
      width: rendered.metadata.width,
      height: rendered.metadata.height,
      durationMs: rendered.metadata.durationMs,
      hasAudio: false,
      sha256,
      sourceUrl,
      sourcePublisher: "AffiliateOS",
      sourceProvider: "affiliateos-illustrative-renderer",
      sourceCandidateId: null,
      sourceLandingPageUrl: null,
      sourceTitle: "AI-assisted text-led promotional illustration; not a product photograph or depiction",
      sourceQuery: "illustrative-product-promo-v1",
      sourceCreator: "AffiliateOS",
      sourceCreatorUrl: null,
      sourceLicense: null,
      sourceLicenseVersion: null,
      sourceLicenseUrl: null,
      rightsStatus: "unverified",
      rightsBasis: null,
      rightsEvidenceUrl: null,
      rightsVerifiedAt: null,
      identityStatus: "not_required",
      identityReviewedBy: null,
      identityReviewedAt: null,
      identityReviewReason: "Text-led abstract illustration; does not depict the physical product.",
      createdAt: new Date().toISOString()
    };

    try {
      const saved = await this.assets.save(asset);
      if (saved.objectKey !== stored.key) {
        try { await this.storage.remove(stored.key); } catch {}
        return { generated: false, asset: saved, reason: "A concurrent request saved the illustrative asset first." };
      }
      return { generated: true, asset: saved };
    } catch (error) {
      try { await this.storage.remove(stored.key); } catch {}
      throw error;
    }
  }
}
