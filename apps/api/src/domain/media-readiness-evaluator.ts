import type { ContentPlatform } from "@affiliateos/shared";
import type { MediaAsset } from "./media-asset.js";
import type { ProductMediaAsset } from "./product-media-ingestion.js";

export type MediaReadinessCheckStatus = "pass" | "fail" | "unknown";
export type MediaReadinessStatus = "ready" | "review_required" | "not_ready";

export interface MediaReadinessCheck {
  key: string;
  status: MediaReadinessCheckStatus;
  detail: string;
}
export interface MediaReadinessResult {
  platform: ContentPlatform;
  mediaAssetId: string;
  status: MediaReadinessStatus;
  checks: MediaReadinessCheck[];
  limitations: string[];
}
export interface MediaReadinessOptions {
  /** Latest TikTok Creator Info value; never substitute a hard-coded account limit. */
  tiktokMaxVideoPostDurationSec?: number;
}

const MAX_TIKTOK_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TIKTOK_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_INSTAGRAM_VIDEO_BYTES = 1024 * 1024 * 1024;
const check = (key: string, status: MediaReadinessCheckStatus, detail: string): MediaReadinessCheck => ({ key, status, detail });
const classify = (checks: MediaReadinessCheck[]): MediaReadinessStatus =>
  checks.some((item) => item.status === "fail") ? "not_ready"
    : checks.some((item) => item.status === "unknown") ? "review_required" : "ready";

/**
 * Advisory preflight based only on persisted metadata and current Creator Info.
 * Codec, frame rate, bitrate and provider-side account checks are never inferred.
 * This does not grant media rights and is deliberately not a publication gate.
 */
export function evaluateMediaReadiness(
  platform: ContentPlatform,
  asset: Pick<MediaAsset, "id" | "kind" | "mimeType" | "byteSize" | "durationSeconds" | "widthPx" | "heightPx" | "hasAudio">,
  options: MediaReadinessOptions = {}
): MediaReadinessResult {
  const checks: MediaReadinessCheck[] = [];
  const limitations: string[] = [];
  if (asset.kind !== "image" && asset.kind !== "video") {
    checks.push(check("media_kind", "fail", "Jenis aset bukan gambar atau video."));
    return { platform, mediaAssetId: asset.id, status: "not_ready", checks, limitations };
  }

  const sizeValid = typeof asset.byteSize === "number" && Number.isSafeInteger(asset.byteSize) && asset.byteSize > 0;
  if (!sizeValid) checks.push(check("file_size", "unknown", "Ukuran file tidak tersedia atau tidak valid."));
  const width = asset.widthPx;
  const height = asset.heightPx;
  const hasDimensions = typeof width === "number" && Number.isSafeInteger(width) && width > 0 &&
    typeof height === "number" && Number.isSafeInteger(height) && height > 0;
  if (!hasDimensions) checks.push(check("dimensions", "unknown", "Dimensi aktual belum tersedia dari metadata file."));

  if (platform === "tiktok" && asset.kind === "image") {
    checks.push(check("format", asset.mimeType === "image/jpeg" || asset.mimeType === "image/webp" ? "pass" : "fail", "Foto TikTok harus JPEG atau WebP."));
    if (sizeValid) checks.push(check("file_size_limit", asset.byteSize! <= MAX_TIKTOK_PHOTO_BYTES ? "pass" : "fail", "Batas ukuran foto TikTok adalah 20 MB."));
    if (hasDimensions) {
      const longestEdge = Math.max(width!, height!);
      const shortestEdge = Math.min(width!, height!);
      checks.push(check("photo_dimensions", longestEdge <= 1920 && shortestEdge <= 1080 ? "pass" : "fail", "Resolusi foto maksimal 1920 × 1080 piksel, termasuk orientasi potret 1080 × 1920."));
    }
  } else if (platform === "tiktok" && asset.kind === "video") {
    checks.push(check("container", asset.mimeType === "video/mp4" ? "pass" : "fail", "Container video pada jalur ini harus MP4."));
    if (sizeValid) checks.push(check("file_size_limit", asset.byteSize! <= MAX_TIKTOK_VIDEO_BYTES ? "pass" : "fail", "Batas ukuran video TikTok adalah 4 GB."));
    if (hasDimensions) {
      const valid = width! >= 360 && width! <= 4096 && height! >= 360 && height! <= 4096;
      checks.push(check("video_dimensions", valid ? "pass" : "fail", "Lebar dan tinggi harus masing-masing 360–4096 piksel."));
    }
    if (typeof asset.durationSeconds !== "number" || !Number.isFinite(asset.durationSeconds) || asset.durationSeconds <= 0) {
      checks.push(check("duration", "unknown", "Durasi video belum tersedia."));
    } else if (typeof options.tiktokMaxVideoPostDurationSec !== "number" ||
      !Number.isFinite(options.tiktokMaxVideoPostDurationSec) || options.tiktokMaxVideoPostDurationSec <= 0) {
      checks.push(check("creator_duration_limit", "unknown", "Batas durasi akun harus diambil dari TikTok Creator Info terbaru."));
    } else {
      checks.push(check("creator_duration_limit",
        asset.durationSeconds <= options.tiktokMaxVideoPostDurationSec ? "pass" : "fail",
        `Durasi dibandingkan dengan batas akun terbaru ${options.tiktokMaxVideoPostDurationSec} detik.`));
    }
    checks.push(check("codec", "unknown", "Codec belum diekstrak; container MP4 tidak membuktikan codec H.264/H.265."));
    checks.push(check("frame_rate", "unknown", "Frame rate belum diekstrak; rentang 23–60 fps belum dapat dipastikan."));
    limitations.push("Kesiapan TikTok belum final sampai codec dan frame rate diperiksa.");
  } else if (platform === "instagram" && asset.kind === "video") {
    checks.push(check("container", asset.mimeType === "video/mp4" || asset.mimeType === "video/quicktime" ? "pass" : "fail", "Reels menerima container MP4 atau MOV."));
    if (sizeValid) checks.push(check("file_size_limit", asset.byteSize! <= MAX_INSTAGRAM_VIDEO_BYTES ? "pass" : "fail", "Batas ukuran video Reels adalah 1 GB."));
    if (hasDimensions) checks.push(check("video_dimensions", Math.max(width!, height!) <= 1920 ? "pass" : "fail", "Sisi terpanjang video Reels dibatasi 1920 piksel."));
    if (typeof asset.durationSeconds !== "number" || !Number.isFinite(asset.durationSeconds) || asset.durationSeconds <= 0) {
      checks.push(check("duration", "unknown", "Durasi video belum tersedia."));
    } else {
      checks.push(check("duration", asset.durationSeconds >= 3 && asset.durationSeconds <= 900 ? "pass" : "fail", "Durasi Reels harus 3 detik hingga 15 menit."));
    }
    checks.push(check("codec_frame_rate_bitrate", "unknown", "Codec, frame rate, bitrate, dan spesifikasi audio belum diekstrak."));
    limitations.push("Pemeriksaan ini belum membuktikan kompatibilitas codec, frame rate, bitrate, atau audio Reels.");
  } else {
    checks.push(check("platform_rules", "unknown", "Aturan teknis untuk kombinasi platform dan jenis media ini belum dimodelkan."));
  }

  if (asset.kind === "video") {
    checks.push(asset.hasAudio == null
      ? check("audio_track", "unknown", "Keberadaan track audio belum diketahui.")
      : check("audio_track", "pass", asset.hasAudio ? "Track audio terdeteksi." : "Track audio tidak terdeteksi; tidak otomatis dianggap gagal."));
  }
  return { platform, mediaAssetId: asset.id, status: classify(checks), checks, limitations };
}


/**
 * Adapts persisted product-scoped media metadata to the advisory evaluator.
 * Duration is converted from the repository's milliseconds to seconds.
 * Rights provenance is intentionally not interpreted as technical readiness.
 */
export function evaluateProductMediaAssetReadiness(
  platform: ContentPlatform,
  asset: ProductMediaAsset,
  options: MediaReadinessOptions = {}
): MediaReadinessResult {
  return evaluateMediaReadiness(platform, {
    id: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    widthPx: asset.width ?? undefined,
    heightPx: asset.height ?? undefined,
    durationSeconds: asset.durationMs == null ? undefined : asset.durationMs / 1000,
    hasAudio: asset.hasAudio ?? undefined
  }, options);
}
