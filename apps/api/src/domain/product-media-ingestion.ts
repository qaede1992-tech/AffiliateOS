import { createHash, randomUUID } from "node:crypto";
import type { ProductMediaCandidate } from "./product-media-discovery.js";
import { fetchPublicHttps } from "./public-https-fetch.js";
import type { SafePublicHttpsFetchOptions } from "./public-https-fetch.js";
import { isStructurallyValidMedia } from "./media-file-validation.js";
import type { SupabaseStorageClient } from "./supabase-storage.js";

export interface ProductMediaAsset {
  id: string;
  productId: string;
  kind: "image" | "video";
  bucket: string;
  objectKey: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "video/mp4";
  byteSize: number;
  sha256: string;
  sourceUrl: string;
  createdAt: string;
}

export interface ProductMediaAssetRepository {
  findByProductAndHash(productId: string, sha256: string): Promise<ProductMediaAsset | undefined>;
  listByProduct(productId: string): Promise<ProductMediaAsset[]>;
  save(asset: ProductMediaAsset): Promise<ProductMediaAsset>;
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
    candidates: ProductMediaCandidate[];
    transport?: Pick<SafePublicHttpsFetchOptions, "fetchImpl" | "resolveHost">;
  }): Promise<ProductMediaIngestionResult> {
    validateProductId(input.productId);
    if (!input.nonMediaEligibilityPassed) {
      throw new Error("Product must pass non-media affiliate eligibility before media ingestion.");
    }

    const stored: ProductMediaAsset[] = [];
    const skipped: Array<{ url: string; reason: string }> = [];
    const existing = await this.assets.listByProduct(input.productId);
    const alreadyHasImage = existing.some((asset) => asset.kind === "image");

    for (const candidate of input.candidates) {
      try {
        if (candidate.kind === "video" && !alreadyHasImage && !stored.some((asset) => asset.kind === "image")) {
          // Video is optional; keep processing it only if it is a candidate. It may
          // still be stored, but it cannot by itself make a product publishable.
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

        const sha256 = createHash("sha256").update(response.bytes).digest("hex");
        const prior = await this.assets.findByProductAndHash(input.productId, sha256);
        if (prior) {
          stored.push(prior);
          continue;
        }
        const id = randomUUID();
        const objectKey = `products/${input.productId}/${sha256}.${EXTENSION[mimeType]}`;
        const savedObject = await this.storage.upload({ key: objectKey, bytes: response.bytes, contentType: mimeType, upsert: true });
        const asset: ProductMediaAsset = {
          id, productId: input.productId, kind: candidate.kind, bucket: savedObject.bucket,
          objectKey: savedObject.key, mimeType, byteSize: response.bytes.byteLength,
          sha256, sourceUrl: candidate.url, createdAt: new Date().toISOString()
        };
        try {
          stored.push(await this.assets.save(asset));
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
