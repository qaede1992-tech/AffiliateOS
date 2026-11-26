import { createHash, randomUUID } from "node:crypto";
import type { Product } from "@affiliateos/shared";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "./product-media-ingestion.js";
import type { SupabaseStorageClient } from "./supabase-storage.js";
import { extractProductMediaTechnicalMetadata } from "./product-media-technical-metadata.js";
import { isStructurallyValidMedia } from "./media-file-validation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_PREFIX = "generated:openai-abstract-illustration:v1:";
const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface ProductIllustrativeImageGenerationOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  fetchImpl?: typeof fetch;
}

export class ProductIllustrativeImageGenerationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_PRODUCT_ID"
      | "PRODUCT_NOT_FOUND"
      | "PRODUCT_NOT_ACTIVE"
      | "AI_PROVIDER_UNAVAILABLE"
      | "AI_PROVIDER_REJECTED"
      | "AI_PROVIDER_INVALID_RESPONSE"
      | "GENERATED_IMAGE_INVALID"
  ) {
    super(message);
    this.name = "ProductIllustrativeImageGenerationError";
  }
}

const safeCategory = (value: unknown): string => {
  if (typeof value !== "string") return "general consumer goods";
  const normalized = value.normalize("NFKC").toLowerCase();
  const groups: Array<[RegExp, string]> = [
    [/fashion|clothing|apparel|pakaian|tas|sepatu|hijab/, "fashion and accessories"],
    [/electronic|gadget|computer|phone|audio|elektronik/, "consumer electronics"],
    [/beauty|cosmetic|skincare|makeup|kecantikan/, "beauty and personal care"],
    [/kitchen|home|household|dapur|rumah|storage/, "home and kitchen"],
    [/sport|fitness|outdoor|olahraga/, "sports and outdoor"],
    [/baby|child|kids|bayi|anak/, "baby and children"],
    [/pet|animal|hewan|kucing|anjing/, "pet supplies"],
    [/food|drink|snack|makanan|minuman/, "food and beverages"],
    [/auto|car|motor|kendaraan|otomotif/, "automotive accessories"],
    [/office|stationery|school|kantor|alat tulis/, "office and stationery"],
    [/toy|game|mainan/, "toys and games"]
  ];
  return groups.find(([pattern]) => pattern.test(normalized))?.[1] ?? "general consumer goods";
};

const readBounded = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("AI image response exceeds the configured size limit.");
  }
  if (!response.body) throw new Error("AI image provider returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value) continue;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("AI image response exceeds the configured size limit.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("AI image provider returned an empty response.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/**
 * Creates a category-inspired abstract artwork, never a depiction of the
 * physical Shopee product. The resulting asset remains rights-unverified.
 */
export class ProductIllustrativeImageGenerationService {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly products: { findById(id: string): Promise<Product | undefined> },
    private readonly assets: ProductMediaAssetRepository,
    private readonly storage: SupabaseStorageClient,
    options: ProductIllustrativeImageGenerationOptions
  ) {
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!this.apiKey) throw new Error("OpenAI API key is required for illustrative image generation.");
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(this.model)) throw new Error("Invalid image generation model identifier.");
    for (const value of [this.timeoutMs, this.maxOutputBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Image generation limits must be positive safe integers.");
    }
  }

  async generate(productId: string): Promise<{ generated: boolean; asset: ProductMediaAsset; reason?: string }> {
    if (!UUID.test(productId)) {
      throw new ProductIllustrativeImageGenerationError("A valid product UUID is required.", "INVALID_PRODUCT_ID");
    }
    const product = await this.products.findById(productId);
    if (!product) throw new ProductIllustrativeImageGenerationError("Product does not exist.", "PRODUCT_NOT_FOUND");
    if (product.status !== "active") {
      throw new ProductIllustrativeImageGenerationError("Only active products can receive promotional illustrations.", "PRODUCT_NOT_ACTIVE");
    }

    const category = safeCategory(product.category);
    const sourceUrl = `${SOURCE_PREFIX}${encodeURIComponent(category)}`;
    const existing = await this.assets.findByProductAndSourceUrl?.(productId, sourceUrl, "image");
    if (existing) return { generated: false, asset: existing, reason: "An abstract AI illustration already exists for this product category." };

    const prompt = [
      "Create one premium, polished, abstract editorial illustration to use as a decorative background for an affiliate social-media promotion.",
      `Broad category inspiration: ${category}. Treat this category label only as a general visual theme.`,
      "Use elegant geometric forms, tasteful textures, balanced composition, and a professional commercial color palette.",
      "IMPORTANT: Do not depict, render, imitate, or imply a real physical product, package, device, garment, food item, person, or recognizable branded object.",
      "Do not include logos, trademarks, product labels, text, numbers, prices, claims, certifications, medical imagery, or watermarks.",
      "The artwork must clearly function as abstract decoration only, not as a product photograph or evidence of product features.",
      "Square 1:1 composition with safe negative space for a separate text overlay."
    ].join(" ");

    let response: Response;
    try {
      response = await this.fetchImpl("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt,
          n: 1,
          size: "1024x1024",
          quality: "medium",
          output_format: "webp",
          moderation: "auto"
        }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new ProductIllustrativeImageGenerationError("The AI image provider could not be reached.", "AI_PROVIDER_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProductIllustrativeImageGenerationError(`The AI image provider rejected the request (HTTP ${response.status}).`, "AI_PROVIDER_REJECTED");
    }

    let payload: { data?: Array<{ b64_json?: string }> };
    try {
      const raw = await readBounded(response, Math.ceil(this.maxOutputBytes * 4 / 3) + 64 * 1024);
      payload = JSON.parse(new TextDecoder().decode(raw)) as { data?: Array<{ b64_json?: string }> };
    } catch {
      throw new ProductIllustrativeImageGenerationError("The AI image provider returned an invalid or oversized response.", "AI_PROVIDER_INVALID_RESPONSE");
    }
    const encoded = payload.data?.[0]?.b64_json;
    if (typeof encoded !== "string" || encoded.length === 0 ||
        encoded.length > Math.ceil(this.maxOutputBytes * 4 / 3) + 16 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new ProductIllustrativeImageGenerationError("The AI image provider did not return a valid encoded image.", "AI_PROVIDER_INVALID_RESPONSE");
    }
    const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxOutputBytes ||
        !isStructurallyValidMedia("image/webp", bytes)) {
      throw new ProductIllustrativeImageGenerationError("The generated image is not a valid WebP within the configured size limit.", "GENERATED_IMAGE_INVALID");
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const duplicate = await this.assets.findByProductAndHash(productId, sha256);
    if (duplicate) return { generated: false, asset: duplicate, reason: "An identical image asset already exists for this product." };

    const id = randomUUID();
    const objectKey = `products/${productId}/ai-abstract-${sha256}-${id}.webp`;
    const stored = await this.storage.upload({ key: objectKey, bytes, contentType: "image/webp", upsert: false });
    const metadata = extractProductMediaTechnicalMetadata("image/webp", bytes);
    const asset: ProductMediaAsset = {
      id, productId, kind: "image", bucket: stored.bucket, objectKey: stored.key,
      mimeType: "image/webp", byteSize: bytes.byteLength, ...metadata, sha256,
      sourceUrl, sourcePublisher: "OpenAI", sourceProvider: "openai",
      sourceCandidateId: null, sourceLandingPageUrl: null,
      sourceTitle: "AI-generated abstract decorative illustration; not a depiction of the physical product",
      sourceQuery: category, sourceCreator: "OpenAI image generation", sourceCreatorUrl: null,
      sourceLicense: null, sourceLicenseVersion: null, sourceLicenseUrl: null,
      rightsStatus: "unverified", rightsBasis: null, rightsEvidenceUrl: null, rightsVerifiedAt: null,
      identityStatus: "not_required", identityReviewedBy: null, identityReviewedAt: null,
      identityReviewReason: "Abstract artwork intentionally does not depict the physical product.",
      createdAt: new Date().toISOString()
    };
    try {
      const saved = await this.assets.save(asset);
      if (saved.objectKey !== stored.key) {
        try { await this.storage.remove(stored.key); } catch {}
        return { generated: false, asset: saved, reason: "A concurrent request saved the illustration first." };
      }
      return { generated: true, asset: saved };
    } catch (error) {
      try { await this.storage.remove(stored.key); } catch {}
      throw error;
    }
  }
}
