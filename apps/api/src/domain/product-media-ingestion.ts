import { createHash, randomUUID } from "node:crypto";
import type { ProductMediaCandidate } from "./product-media-discovery.js";
import { fetchPublicHttps } from "./public-https-fetch.js";
import type { SafePublicHttpsFetchOptions } from "./public-https-fetch.js";
import { isStructurallyValidMedia } from "./media-file-validation.js";
import { extractProductMediaTechnicalMetadata, type ProductMediaTechnicalMetadata } from "./product-media-technical-metadata.js";
import type { SupabaseStorageClient } from "./supabase-storage.js";

export interface ProductMediaAsset {
  id: string;
  productId: string;
  kind: "image" | "video";
  bucket: string;
  objectKey: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "video/mp4";
  byteSize: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  hasAudio?: boolean | null;
  sha256: string;
  sourceUrl: string;
  sourcePublisher: string | null;
  sourceProvider?: string | null;
  sourceCandidateId?: string | null;
  sourceLandingPageUrl?: string | null;
  sourceTitle?: string | null;
  sourceQuery?: string | null;
  sourceCreator?: string | null;
  sourceCreatorUrl?: string | null;
  sourceLicense?: string | null;
  sourceLicenseVersion?: string | null;
  sourceLicenseUrl?: string | null;
  rightsStatus: "unverified" | "verified" | "revoked";
  rightsBasis: "explicit_permission" | "license" | "public_domain" | "user_owned" | "platform_authorization" | null;
  rightsEvidenceUrl: string | null;
  rightsVerifiedAt: string | null;
  identityStatus?: "not_required" | "pending" | "verified" | "rejected";
  identityReviewedBy?: string | null;
  identityReviewedAt?: string | null;
  identityReviewReason?: string | null;
  createdAt: string;
}

export interface ProductMediaRightsReviewCommand {
  status: "verified" | "revoked";
  rightsBasis?: Exclude<ProductMediaAsset["rightsBasis"], null>;
  rightsEvidenceUrl?: string;
  sourcePublisher?: string;
  actorId: string;
  actorRole: "admin";
  reason: string;
}

export interface ProductMediaRightsAudit {
  id: string;
  assetId: string;
  productId: string;
  actorId: string;
  actorRole: string;
  action: "verify" | "revoke";
  reason: string;
  previousRightsStatus: string;
  newRightsStatus: string;
  rightsBasis: ProductMediaAsset["rightsBasis"];
  rightsEvidenceUrl: string | null;
  sourcePublisher: string | null;
  createdAt: string;
}

export interface ProductMediaAssetRepository {
  findByProductAndHash(productId: string, sha256: string): Promise<ProductMediaAsset | undefined>;
  findBySourceCandidateId?(candidateId: string): Promise<ProductMediaAsset | undefined>;
  attachCandidateProvenance?(
    productId: string,
    sha256: string,
    sourceUrl: string,
    provenance: {
      provider: string; candidateId: string; landingPageUrl: string; title: string; query: string;
      creator: string | null; creatorUrl: string | null; license: string | null;
      licenseVersion: string | null; licenseUrl: string | null; sourcePublisher: string | null;
    }
  ): Promise<ProductMediaAsset | undefined>;
  listByProduct(productId: string): Promise<ProductMediaAsset[]>;
  listByProducts?(productIds: string[]): Promise<ProductMediaAsset[]>;
  save(asset: ProductMediaAsset): Promise<ProductMediaAsset>;
  /**
   * Implementations must atomically update the asset and append its immutable rights-audit row.
   * Repositories without that transaction must omit this method so the HTTP route fails closed.
   */
  reviewRights?(assetId: string, productId: string, review: ProductMediaRightsReviewCommand): Promise<ProductMediaAsset | undefined>;
  listRightsAudits?(productId: string, assetId: string): Promise<ProductMediaRightsAudit[]>;
}

export interface ProductMediaIngestionPolicy {
  maxImageBytes: number;
  maxVideoBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface ProductMediaIngestionResult {
  stored: ProductMediaAsset[];
  skipped: Array<{ url: string; reason: string }>;
}

const MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "video/mp4"] as const;
type SupportedMime = typeof MIME_TYPES[number];
const EXTENSION: Record<SupportedMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4"
};

const detectMime = (bytes: Uint8Array): SupportedMime | undefined =>
  MIME_TYPES.find((mimeType) => isStructurallyValidMedia(mimeType, bytes));

const validateProductId = (productId: string): void => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(productId)) {
    throw new Error("A valid product UUID is required.");
  }
};

/**
 * Downloads and stores product-owned media. This deliberately does not create content.
 * Callers must only invoke it for products that passed non-media affiliate eligibility
 * checks; final publish selection must still validate offer, commission, score and media.
 */
export class ProductMediaIngestionService {
  constructor(
    private readonly storage: SupabaseStorageClient,
    private readonly assets: ProductMediaAssetRepository,
    private readonly policy: ProductMediaIngestionPolicy,
    private readonly fetcher: typeof fetchPublicHttps = fetchPublicHttps
  ) {
    for (const [name, value] of Object.entries(policy)) {
      if (name.endsWith("Bytes") && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new Error(`Product media policy ${name} must be a positive safe integer.`);
      }
    }
  }

  async ingest(input: {
    productId: string;
    nonMediaEligibilityPassed: boolean;
    candidates: Array<ProductMediaCandidate & {
      provenance?: {
        provider: string; candidateId: string; landingPageUrl: string; title: string; query: string;
        creator: string | null; creatorUrl: string | null; license: string | null;
        licenseVersion: string | null; licenseUrl: string | null; sourcePublisher: string | null;
      };
    }>;
    transport?: Pick<SafePublicHttpsFetchOptions, "fetchImpl" | "resolveHost">;
  }): Promise<ProductMediaIngestionResult> {
    validateProductId(input.productId);
    if (!input.nonMediaEligibilityPassed) {
      throw new Error("Product must pass non-media affiliate eligibility before media ingestion.");
    }

    const stored: ProductMediaAsset[] = [];
    const skipped: Array<{ url: string; reason: string }> = [];
    // Video is the preferred campaign format. Do not require an image before
    // ingesting a valid video; image candidates are useful fallback media only.
    const orderedCandidates = [...input.candidates].sort((left, right) =>
      left.kind === right.kind ? 0 : left.kind === "video" ? -1 : 1
    );
    for (const candidate of orderedCandidates) {
      try {
        // A previously ingested provider candidate is immutable for this candidate ID.
        // Reuse its persisted asset before downloading bytes again; this avoids repeated
        // source-network transfer and unnecessary Supabase Storage writes on later cycles.
        if (candidate.provenance && this.assets.findBySourceCandidateId) {
          const existingCandidateAsset = await this.assets.findBySourceCandidateId(candidate.provenance.candidateId);
          if (existingCandidateAsset) {
            // A provider candidate is product-scoped. Never let a stale or mismatched
            // provenance reference make another product's asset appear reusable here.
            if (existingCandidateAsset.productId !== input.productId) {
              skipped.push({ url: candidate.url, reason: "candidate_asset_product_mismatch" });
              continue;
            }
            stored.push(existingCandidateAsset);
            continue;
          }
        }
        const limit = candidate.kind === "video" ? this.policy.maxVideoBytes : this.policy.maxImageBytes;
        const response = await this.fetcher(candidate.url, {
          maxBytes: limit,
          timeoutMs: this.policy.timeoutMs,
          maxRedirects: this.policy.maxRedirects,
          ...input.transport
        });
        if (response.status < 200 || response.status >= 300) throw new Error("Media source returned an unsuccessful status.");
        const mimeType = detectMime(response.bytes);
        if (!mimeType) throw new Error("Downloaded bytes are not a supported, structurally valid image or MP4.");
        if ((candidate.kind === "image") !== mimeType.startsWith("image/")) {
          throw new Error("Downloaded media kind does not match the extracted candidate.");
        }
        if (response.bytes.byteLength > limit) throw new Error("Downloaded media exceeds configured size limit.");

        const technicalMetadata: ProductMediaTechnicalMetadata = extractProductMediaTechnicalMetadata(mimeType, response.bytes);
        const sha256 = createHash("sha256").update(response.bytes).digest("hex");
        const prior = await this.assets.findByProductAndHash(input.productId, sha256);
        if (prior) {
          if (candidate.provenance && !prior.sourceCandidateId && prior.rightsStatus === "unverified" && this.assets.attachCandidateProvenance) {
            const linked = await this.assets.attachCandidateProvenance(input.productId, sha256, candidate.url, candidate.provenance);
            if (linked) {
              stored.push(linked);
              continue;
            }
            skipped.push({ url: candidate.url, reason: "existing_asset_provenance_could_not_be_safely_linked" });
            continue;
          }
          if (candidate.provenance && prior.sourceCandidateId !== candidate.provenance.candidateId) {
            skipped.push({ url: candidate.url, reason: "existing_asset_has_conflicting_candidate_provenance_or_verified_rights" });
            continue;
          }
          stored.push(prior);
          continue;
        }
        const id = randomUUID();
        // Isolate concurrent uploads: a losing duplicate insert must never remove the winner's object.
        const objectKey = `products/${input.productId}/${sha256}-${randomUUID()}.${EXTENSION[mimeType]}`;
        const savedObject = await this.storage.upload({ key: objectKey, bytes: response.bytes, contentType: mimeType, upsert: true });
        const asset: ProductMediaAsset = {
          id, productId: input.productId, kind: candidate.kind, bucket: savedObject.bucket,
          objectKey: savedObject.key, mimeType, byteSize: response.bytes.byteLength,
          ...technicalMetadata, sha256, sourceUrl: candidate.url,
          sourcePublisher: candidate.provenance?.sourcePublisher ?? null,
          sourceProvider: candidate.provenance?.provider ?? null,
          sourceCandidateId: candidate.provenance?.candidateId ?? null,
          sourceLandingPageUrl: candidate.provenance?.landingPageUrl ?? null,
          sourceTitle: candidate.provenance?.title ?? null,
          sourceQuery: candidate.provenance?.query ?? null,
          sourceCreator: candidate.provenance?.creator ?? null,
          sourceCreatorUrl: candidate.provenance?.creatorUrl ?? null,
          sourceLicense: candidate.provenance?.license ?? null,
          sourceLicenseVersion: candidate.provenance?.licenseVersion ?? null,
          sourceLicenseUrl: candidate.provenance?.licenseUrl ?? null,
          rightsStatus: "unverified",
          rightsBasis: null, rightsEvidenceUrl: null, rightsVerifiedAt: null, createdAt: new Date().toISOString()
        };
        try {
          const persisted = await this.assets.save(asset);
          // A concurrent insert may return the winning row instead of throwing.
          // Remove only this worker's uniquely named object when that happens.
          if (persisted.objectKey !== savedObject.key) {
            try { await this.storage.remove(savedObject.key); } catch {}
          }
          stored.push(persisted);
        } catch (error) {
          try { await this.storage.remove(savedObject.key); } catch {}
          throw error;
        }
      } catch (error) {
        skipped.push({ url: candidate.url, reason: error instanceof Error ? error.message : "Unknown media ingestion failure." });
      }
    }
    return { stored, skipped };
  }
}
