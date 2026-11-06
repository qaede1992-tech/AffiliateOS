import { createHash, randomUUID } from "node:crypto";
import type { ProductMediaAsset, ProductMediaAssetRepository, ProductMediaIngestionPolicy } from "./product-media-ingestion.js";
import { isStructurallyValidMedia } from "./media-file-validation.js";
import { extractProductMediaTechnicalMetadata } from "./product-media-technical-metadata.js";

export interface ProductMediaUploadStorage {
  upload(input: { key: string; bytes: Uint8Array; contentType: string }): Promise<{ bucket: string; key: string }>;
  remove(key: string): Promise<void>;
}

export interface ProductMediaProductReader {
  findById(productId: string): Promise<unknown | undefined>;
}

export class ProductMediaUploadError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_PRODUCT_ID" | "PRODUCT_NOT_FOUND" | "INVALID_MEDIA_KIND" |
      "UNSUPPORTED_MEDIA_TYPE" | "INVALID_CONTENT_LENGTH" | "MEDIA_TOO_LARGE" |
      "CONTENT_LENGTH_MISMATCH" | "UPLOAD_CANCELLED" | "INVALID_MEDIA_BYTES"
  ) {
    super(message);
    this.name = "ProductMediaUploadError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4"
};
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export class ProductMediaUploadService {
  constructor(
    private readonly products: ProductMediaProductReader,
    private readonly assets: ProductMediaAssetRepository,
    private readonly storage: ProductMediaUploadStorage,
    private readonly policy: Pick<ProductMediaIngestionPolicy, "maxImageBytes" | "maxVideoBytes">
  ) {
    for (const [name, value] of Object.entries(policy)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Product media upload policy ${name} must be a positive safe integer.`);
      }
    }
  }

  async uploadStream(input: {
    productId: string;
    kind: "image" | "video";
    mimeType: string;
    body: ReadableStream<Uint8Array>;
    contentLength: number;
    signal?: AbortSignal;
  }): Promise<ProductMediaAsset> {
    if (!UUID.test(input.productId)) {
      throw new ProductMediaUploadError("A valid product UUID is required.", "INVALID_PRODUCT_ID");
    }
    if (!(await this.products.findById(input.productId))) {
      throw new ProductMediaUploadError("Product does not exist.", "PRODUCT_NOT_FOUND");
    }
    if (input.kind !== "image" && input.kind !== "video") {
      throw new ProductMediaUploadError("A supported product media kind is required.", "INVALID_MEDIA_KIND");
    }
    if (input.kind === "image" ? !IMAGE_TYPES.has(input.mimeType) : input.mimeType !== "video/mp4") {
      throw new ProductMediaUploadError("Media type does not match the declared product media kind.", "UNSUPPORTED_MEDIA_TYPE");
    }

    const limit = input.kind === "video" ? this.policy.maxVideoBytes : this.policy.maxImageBytes;
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0) {
      throw new ProductMediaUploadError("A positive Content-Length is required.", "INVALID_CONTENT_LENGTH");
    }
    if (input.contentLength > limit) {
      throw new ProductMediaUploadError("Product media exceeds the configured size limit.", "MEDIA_TOO_LARGE");
    }

    const reader = input.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const cancelOnAbort = () => { void reader.cancel().catch(() => {}); };
    input.signal?.addEventListener("abort", cancelOnAbort, { once: true });
    if (input.signal?.aborted) cancelOnAbort();
    try {
      while (true) {
        if (input.signal?.aborted) {
          throw new ProductMediaUploadError("Product media upload was cancelled.", "UPLOAD_CANCELLED");
        }
        const part = await reader.read();
        if (part.done) break;
        if (!part.value) continue;
        total += part.value.byteLength;
        if (total > limit) {
          throw new ProductMediaUploadError("Product media exceeds the configured size limit.", "MEDIA_TOO_LARGE");
        }
        if (total > input.contentLength) {
          throw new ProductMediaUploadError("Uploaded bytes exceed Content-Length.", "CONTENT_LENGTH_MISMATCH");
        }
        chunks.push(part.value);
      }
    } catch (error) {
      try { await reader.cancel(error); } catch {}
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", cancelOnAbort);
      try { reader.releaseLock(); } catch {}
    }
    if (input.signal?.aborted) {
      throw new ProductMediaUploadError("Product media upload was cancelled.", "UPLOAD_CANCELLED");
    }
    if (total !== input.contentLength) {
      throw new ProductMediaUploadError("Uploaded bytes do not match Content-Length.", "CONTENT_LENGTH_MISMATCH");
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (!isStructurallyValidMedia(input.mimeType, bytes)) {
      throw new ProductMediaUploadError("Media bytes do not match the declared MIME type.", "INVALID_MEDIA_BYTES");
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = await this.assets.findByProductAndHash(input.productId, sha256);
    if (existing) return existing;

    const metadata = extractProductMediaTechnicalMetadata(input.mimeType, bytes);
    const id = randomUUID();
    const objectKey = `products/${input.productId}/${sha256}-${id}.${EXTENSION[input.mimeType]}`;
    let stored: { bucket: string; key: string };
    try {
      stored = await this.storage.upload({ key: objectKey, bytes, contentType: input.mimeType });
    } catch (error) {
      try { await this.storage.remove(objectKey); } catch {}
      throw error;
    }

    const asset: ProductMediaAsset = {
      id,
      productId: input.productId,
      kind: input.kind,
      bucket: stored.bucket,
      objectKey: stored.key,
      mimeType: input.mimeType as ProductMediaAsset["mimeType"],
      byteSize: bytes.byteLength,
      ...metadata,
      sha256,
      sourceUrl: `user-upload://${id}`,
      sourcePublisher: "user-provided",
      sourceProvider: "user_upload",
      sourceCandidateId: null,
      sourceLandingPageUrl: null,
      sourceTitle: null,
      sourceQuery: null,
      sourceCreator: null,
      sourceCreatorUrl: null,
      sourceLicense: null,
      sourceLicenseVersion: null,
      sourceLicenseUrl: null,
      rightsStatus: "unverified",
      rightsBasis: null,
      rightsEvidenceUrl: null,
      rightsVerifiedAt: null,
      createdAt: new Date().toISOString()
    };
    try {
      const persisted = await this.assets.save(asset);
      // A concurrent upload may win the unique product/hash insert. Keep only
      // the object referenced by the persisted row and remove this upload's orphan.
      if (persisted.objectKey !== stored.key) {
        try { await this.storage.remove(stored.key); } catch {}
      }
      return persisted;
    } catch (error) {
      try { await this.storage.remove(stored.key); } catch {}
      throw error;
    }
  }
}
