import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Product } from "@affiliateos/shared";
import { isStructurallyValidMedia } from "./media-file-validation.js";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "./product-media-ingestion.js";
import type { SupabaseStorageClient } from "./supabase-storage.js";

const execFile = promisify(execFileCallback);
const DEFAULT_MAX_OUTPUT_BYTES = 45 * 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const VIDEO_DURATION_SECONDS = 12;
const VIDEO_FPS = 25;
const FONT_PATH = "/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf";

export interface ProductPromoVideoRendererOptions {
  ffmpegPath?: string;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
  /** Test seam; production uses execFile without a shell. */
  runProcess?: (binary: string, args: string[]) => Promise<void>;
}

export interface ProductPromoVideoRenderResult {
  generated: boolean;
  asset?: ProductMediaAsset;
  reason?: string;
}

const defaultRunProcess = async (binary: string, args: string[]): Promise<void> => {
  await execFile(binary, args, { timeout: 90_000, maxBuffer: 1024 * 1024, windowsHide: true });
};

const safeTitle = (name: string): string => {
  const normalized = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  return chars.length > 38 ? `${chars.slice(0, 37).join("")}…` : normalized || "Produk pilihan";
};

const escapeFilterPath = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

const buildFilter = (textPath: string): string => [
  "scale=720:1280:force_original_aspect_ratio=increase",
  "crop=720:1280",
  "zoompan=z='min(zoom+0.0007,1.10)':d=300:s=720x1280:fps=25",
  `drawtext=fontfile=${FONT_PATH}:textfile=${escapeFilterPath(textPath)}:reload=0:fontcolor=white:fontsize=42:borderw=3:bordercolor=black:box=1:boxcolor=black@0.55:boxborderw=24:x=(w-text_w)/2:y=h*0.76`,
  "fade=t=in:st=0:d=0.5",
  "fade=t=out:st=11:d=1"
].join(",");

/**
 * Creates a silent 9:16 product promo from an already validated, private product
 * image. It never fetches marketplace pages or creates social content itself.
 */
export class ProductPromoVideoRenderer {
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly runProcess: (binary: string, args: string[]) => Promise<void>;

  constructor(
    private readonly storage: Pick<SupabaseStorageClient, "bucketName" | "download" | "upload" | "remove">,
    private readonly assets: ProductMediaAssetRepository,
    private readonly options: ProductPromoVideoRendererOptions = {}
  ) {
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.runProcess = options.runProcess ?? defaultRunProcess;
    if (!Number.isSafeInteger(this.maxInputBytes) || this.maxInputBytes <= 0 ||
        !Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new Error("Promo video input and output limits must be positive safe integers.");
    }
  }

  async render(product: Pick<Product, "id" | "name">): Promise<ProductPromoVideoRenderResult> {
    const existing = await this.assets.listByProduct(product.id);
    const existingVideo = existing.find((asset) => asset.kind === "video");
    if (existingVideo) return { generated: false, asset: existingVideo, reason: "A validated product video already exists." };

    const image = existing.find((asset) => asset.kind === "image" && asset.bucket === this.storage.bucketName);
    if (!image) return { generated: false, reason: "No validated product image is available in private storage." };
    if (!this.storage.download) return { generated: false, reason: "Supabase Storage download is not available in this runtime." };

    const tempDir = await mkdtemp(join(tmpdir(), "affiliateos-promo-"));
    let uploadedKey: string | undefined;
    try {
      const imageBytes = await this.storage.download(image.objectKey, this.maxInputBytes);
      if (imageBytes.byteLength === 0 || imageBytes.byteLength > this.maxInputBytes ||
          !isStructurallyValidMedia(image.mimeType, imageBytes)) {
        return { generated: false, reason: "Stored product image failed validation before rendering." };
      }

      const imagePath = join(tempDir, `source.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/png" ? "png" : "webp"}`);
      const textPath = join(tempDir, "overlay.txt");
      const outputPath = join(tempDir, "promo.mp4");
      await writeFile(imagePath, imageBytes, { flag: "wx" });
      await writeFile(textPath, `${safeTitle(product.name)}\nLihat detail produk`, { encoding: "utf8", flag: "wx" });

      try {
        await this.runProcess(this.options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-y",
          "-loop", "1", "-framerate", String(VIDEO_FPS), "-i", imagePath,
          "-vf", buildFilter(textPath),
          "-t", String(VIDEO_DURATION_SECONDS), "-r", String(VIDEO_FPS),
          "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
          "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath
        ]);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") return { generated: false, reason: "FFmpeg is not installed in this API runtime." };
        return { generated: false, reason: "FFmpeg could not render the product promo video." };
      }

      const outputStats = await stat(outputPath);
      if (!outputStats.isFile() || outputStats.size <= 0 || outputStats.size > this.maxOutputBytes) {
        return { generated: false, reason: "Rendered video is empty or exceeds the configured output size limit." };
      }
      const videoBytes = await readFile(outputPath);
      if (!isStructurallyValidMedia("video/mp4", videoBytes)) {
        return { generated: false, reason: "FFmpeg output is not a structurally valid MP4." };
      }

      const sha256 = createHash("sha256").update(videoBytes).digest("hex");
      const prior = await this.assets.findByProductAndHash(product.id, sha256);
      if (prior) return { generated: false, asset: prior, reason: "An identical generated video already exists." };

      const objectKey = `products/${product.id}/${sha256}.mp4`;
      const stored = await this.storage.upload({ key: objectKey, bytes: videoBytes, contentType: "video/mp4", upsert: true });
      uploadedKey = stored.key;
      const asset: ProductMediaAsset = {
        id: randomUUID(),
        productId: product.id,
        kind: "video",
        bucket: stored.bucket,
        objectKey: stored.key,
        mimeType: "video/mp4",
        byteSize: videoBytes.byteLength,
        sha256,
        sourceUrl: "generated:ffmpeg",
        createdAt: new Date().toISOString()
      };
      try {
        const saved = await this.assets.save(asset);
        uploadedKey = undefined;
        return { generated: true, asset: saved };
      } catch (error) {
        try { await this.storage.remove(stored.key); } catch {}
        uploadedKey = undefined;
        throw error;
      }
    } catch (error) {
      return { generated: false, reason: error instanceof Error ? error.message : "Product promo video generation failed." };
    } finally {
      if (uploadedKey) {
        try { await this.storage.remove(uploadedKey); } catch {}
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
