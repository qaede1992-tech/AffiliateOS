import { createHash, randomUUID } from "node:crypto";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "./product-media-ingestion.js";
import { extractProductMediaTechnicalMetadata } from "./product-media-technical-metadata.js";
import { isStructurallyValidMedia } from "./media-file-validation.js";
import { hasCurrentVerifiedRights } from "./product-media-publication-rights.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MODEL = "gpt-image-2.5-sunburst";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export type ProductImageEditStyle = "studio" | "lifestyle" | "minimal";

export interface ProductImageGenerationStorage {
  bucketName: string;
  download(key: string, maxBytes: number): Promise<Uint8Array>;
  upload(input: { key: string; bytes: Uint8Array; contentType: string; upsert?: boolean }): Promise<{ bucket: string; key: string }>;
  remove(key: string): Promise<void>;
}

export interface ProductImageGenerationProductReader {
  findById(productId: string): Promise<unknown | undefined>;
}

export interface ProductImageGenerationOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface ProductImageGenerationResult {
  generated: boolean;
  asset?: ProductMediaAsset;
  reason?: string;
}

export class ProductImageGenerationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_PRODUCT_ID"
      | "INVALID_REFERENCE_ASSET"
      | "PRODUCT_NOT_FOUND"
      | "REFERENCE_NOT_FOUND"
      | "REFERENCE_NOT_ELIGIBLE"
      | "AI_PROVIDER_UNAVAILABLE"
      | "AI_PROVIDER_REJECTED"
      | "AI_PROVIDER_INVALID_RESPONSE"
      | "GENERATED_IMAGE_INVALID"
  ) {
    super(message);
    this.name = "ProductImageGenerationError";
  }
}

const STYLE_INSTRUCTIONS: Record<ProductImageEditStyle, string> = {
  studio: "Place the exact product in a premium, neutral studio product-photography scene with soft professional lighting and a clean background.",
  lifestyle: "Place the exact product in a realistic, tasteful lifestyle environment appropriate to the product category. Keep the product clearly visible and dominant.",
  minimal: "Place the exact product in a refined minimalist commercial scene with a restrained background, natural soft shadows, and generous negative space."
};

const buildPrompt = (style: ProductImageEditStyle): string => [
  "Edit the supplied reference photograph for a commercial product listing.",
  "PRODUCT IDENTITY IS THE HIGHEST PRIORITY. Preserve the physical product exactly as shown in the reference.",
  "Do not redesign, redraw, reinterpret, replace, beautify, or alter the product itself.",
  "Preserve its exact silhouette, proportions, geometry, color, material, texture, components, labels, packaging, logos, printed text, buttons, ports, and all visible identifying details.",
  "Do not add product features, accessories, claims, certifications, brand marks, text, or objects that are not present in the reference.",
  "Only change the background, surrounding environment, lighting, and photographic composition. Do not cover or crop any important part of the product.",
  "If preserving the exact product details conflicts with the requested scene, keep the original product appearance and simplify the scene.",
  STYLE_INSTRUCTIONS[style],
  "Output one photorealistic image. No promotional text, no watermark, no extra products."
].join(" ");

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
 * Creates a background/composition edit from a rights-verified, user-owned
 * product reference. Generated derivatives are always stored as unverified
 * and require a separate human rights and product-identity review.
 */
export class ProductImageGenerationService {
  private readonly fetchImpl: typeof fetch;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly apiKey: string;

  constructor(
    private readonly products: ProductImageGenerationProductReader,
    private readonly assets: ProductMediaAssetRepository,
    private readonly storage: ProductImageGenerationStorage,
    options: ProductImageGenerationOptions
  ) {
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!this.apiKey) throw new Error("OpenAI API key is required for product image generation.");
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(this.model)) throw new Error("Invalid image generation model identifier.");
    for (const [name, value] of Object.entries({
      timeoutMs: this.timeoutMs,
      maxInputBytes: this.maxInputBytes,
      maxOutputBytes: this.maxOutputBytes
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Product image generation ${name} must be a positive safe integer.`);
    }
  }

  async generate(input: {
    productId: string;
    referenceAssetId: string;
    style: ProductImageEditStyle;
  }): Promise<ProductImageGenerationResult> {
    if (!UUID.test(input.productId)) {
      throw new ProductImageGenerationError("A valid product UUID is required.", "INVALID_PRODUCT_ID");
    }
    if (!UUID.test(input.referenceAssetId)) {
      throw new ProductImageGenerationError("A valid reference asset UUID is required.", "INVALID_REFERENCE_ASSET");
    }
    if (!Object.hasOwn(STYLE_INSTRUCTIONS, input.style)) {
      throw new ProductImageGenerationError("A supported image style is required.", "INVALID_REFERENCE_ASSET");
    }
    if (!(await this.products.findById(input.productId))) {
      throw new ProductImageGenerationError("Product does not exist.", "PRODUCT_NOT_FOUND");
    }

    const productAssets = await this.assets.listByProduct(input.productId);
    const reference = productAssets.find((asset) => asset.id === input.referenceAssetId);
    if (!reference) throw new ProductImageGenerationError("Reference image does not belong to this product.", "REFERENCE_NOT_FOUND");
    if (
      reference.kind !== "image" ||
      reference.bucket !== this.storage.bucketName ||
      !reference.objectKey.startsWith(`products/${input.productId}/`) ||
      !hasCurrentVerifiedRights(reference) ||
      reference.rightsBasis !== "user_owned"
    ) {
      throw new ProductImageGenerationError(
        "AI editing requires a private, rights-verified, user-owned product reference image.",
        "REFERENCE_NOT_ELIGIBLE"
      );
    }

    let sourceBytes: Uint8Array;
    try {
      sourceBytes = await this.storage.download(reference.objectKey, this.maxInputBytes);
    } catch {
      throw new ProductImageGenerationError("The product reference image could not be loaded from private storage.", "REFERENCE_NOT_ELIGIBLE");
    }
    if (
      sourceBytes.byteLength === 0 ||
      sourceBytes.byteLength > this.maxInputBytes ||
      !["image/jpeg", "image/png", "image/webp"].includes(reference.mimeType) ||
      !isStructurallyValidMedia(reference.mimeType, sourceBytes)
    ) {
      throw new ProductImageGenerationError("The product reference image failed file validation.", "REFERENCE_NOT_ELIGIBLE");
    }

    const form = new FormData();
    form.set("model", this.model);
    form.set("prompt", buildPrompt(input.style));
    form.set("size", "1024x1024");
    form.set("quality", "high");
    form.set("output_format", "png");
    form.set("n", "1");
    const extension = reference.mimeType === "image/jpeg" ? "jpg" : reference.mimeType === "image/webp" ? "webp" : "png";
    form.append("image[]", new Blob([sourceBytes], { type: reference.mimeType }), `reference.${extension}`);

    let response: Response;
    try {
      response = await this.fetchImpl("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new ProductImageGenerationError("The AI image provider could not be reached.", "AI_PROVIDER_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProductImageGenerationError(
        `The AI image provider rejected the request (HTTP ${response.status}).`,
        "AI_PROVIDER_REJECTED"
      );
    }

    let payload: { data?: Array<{ b64_json?: string }> };
    try {
      const bytes = await readBounded(response, this.maxOutputBytes * 2);
      payload = JSON.parse(new TextDecoder().decode(bytes)) as { data?: Array<{ b64_json?: string }> };
    } catch {
      throw new ProductImageGenerationError("The AI image provider returned an invalid or oversized response.", "AI_PROVIDER_INVALID_RESPONSE");
    }
    const encoded = payload.data?.[0]?.b64_json;
    if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > Math.ceil(this.maxOutputBytes * 4 / 3) + 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new ProductImageGenerationError("The AI image provider response did not contain a valid image.", "AI_PROVIDER_INVALID_RESPONSE");
    }

    const outputBytes = new Uint8Array(Buffer.from(encoded, "base64"));
    if (
      outputBytes.byteLength === 0 ||
      outputBytes.byteLength > this.maxOutputBytes ||
      !isStructurallyValidMedia("image/png", outputBytes)
    ) {
      throw new ProductImageGenerationError("The generated output is not a valid PNG image.", "GENERATED_IMAGE_INVALID");
    }

    const sha256 = createHash("sha256").update(outputBytes).digest("hex");
    const existing = await this.assets.findByProductAndHash(input.productId, sha256);
    if (existing) return { generated: false, asset: existing, reason: "An identical generated product image already exists." };

    const id = randomUUID();
    const objectKey = `products/${input.productId}/ai-${sha256}-${id}.png`;
    const stored = await this.storage.upload({ key: objectKey, bytes: outputBytes, contentType: "image/png", upsert: false });
    const metadata = extractProductMediaTechnicalMetadata("image/png", outputBytes);
    const asset: ProductMediaAsset = {
      id,
      productId: input.productId,
      kind: "image",
      bucket: stored.bucket,
      objectKey: stored.key,
      mimeType: "image/png",
      byteSize: outputBytes.byteLength,
      ...metadata,
      sha256,
      sourceUrl: `generated:openai-image-edit:${reference.id}`,
      sourcePublisher: "AffiliateOS AI",
      sourceProvider: "openai",
      sourceCandidateId: null,
      sourceLandingPageUrl: null,
      sourceTitle: `AI-edited derivative; reference asset ${reference.id}; style ${input.style}`,
      sourceQuery: input.style,
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
      const saved = await this.assets.save(asset);
      if (saved.objectKey !== stored.key) {
        try { await this.storage.remove(stored.key); } catch {}
      }
      return { generated: saved.objectKey === stored.key, asset: saved, reason: saved.objectKey === stored.key ? undefined : "An identical image was saved by a concurrent request." };
    } catch (error) {
      try { await this.storage.remove(stored.key); } catch {}
      throw error;
    }
  }
}
