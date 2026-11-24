import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStructurallyValidMedia } from "./media-file-validation.js";

const execFile = promisify(execFileCallback);
const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 25;
const DURATION_SECONDS = 12;
const DEFAULT_MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const FONT_PATH = "/usr/share/fonts/dejavu/DejaVuSans.ttf";

export interface IllustrativeProductVideoInput {
  productName: string;
  /** Product price in the application's integer minor-unit representation. */
  priceCents: number;
  currency: string;
}

export interface IllustrativeProductVideoMetadata {
  mimeType: "video/mp4";
  width: 720;
  height: 1280;
  durationMs: 12_000;
  fps: 25;
  codec: "h264";
  sha256: string;
  byteSize: number;
}

export interface IllustrativeProductVideoResult {
  bytes: Uint8Array;
  metadata: IllustrativeProductVideoMetadata;
}

export interface IllustrativeProductVideoRendererOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  fontPath?: string;
  maxOutputBytes?: number;
  timeoutMs?: number;
  /** Test seams. Production uses execFile without a shell. */
  runProcess?: (binary: string, args: string[], timeoutMs: number) => Promise<void>;
  probeProcess?: (binary: string, args: string[], timeoutMs: number) => Promise<string>;
}

interface ProbeResult {
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; avg_frame_rate?: string }>;
  format?: { duration?: string };
}

const defaultRunProcess = async (binary: string, args: string[], timeoutMs: number): Promise<void> => {
  await execFile(binary, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true });
};

const defaultProbeProcess = async (binary: string, args: string[], timeoutMs: number): Promise<string> => {
  const result = await execFile(binary, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true });
  return result.stdout;
};

const cleanText = (value: string, maxLength: number): string => {
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = Array.from(normalized).slice(0, maxLength).join("") || "Produk pilihan";
  const words = bounded.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 20 && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).join("\n");
};

const escapeFilterPath = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

const formatPrice = (priceCents: number, currency: string): string => {
  const amount = priceCents / 100;
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "IDR" ? 0 : 2
  }).format(amount);
};

const buildFilter = (titlePath: string, pricePath: string, fontPath: string): string => [
  "drawbox=x=42:y=300:w=636:h=680:color=0x17243acc:t=fill",
  "drawbox=x=42:y=300:w=12:h=680:color=0x38bdf8:t=fill",
  `drawtext=fontfile=${escapeFilterPath(fontPath)}:text='PROMO PRODUK':fontcolor=0x7dd3fc:fontsize=26:x=82:y=370`,
  `drawtext=fontfile=${escapeFilterPath(fontPath)}:textfile=${escapeFilterPath(titlePath)}:fontcolor=white:fontsize=42:line_spacing=18:expansion=none:fix_bounds=true:x=82:y=455`,
  `drawtext=fontfile=${escapeFilterPath(fontPath)}:textfile=${escapeFilterPath(pricePath)}:fontcolor=0xfde68a:fontsize=48:expansion=none:fix_bounds=true:x=82:y=690`,
  "drawbox=x=82:y=810:w=556:h=3:color=white@0.35:t=fill",
  `drawtext=fontfile=${escapeFilterPath(fontPath)}:text='Lihat detail di halaman produk':fontcolor=white:fontsize=25:x=82:y=860`,
  `drawtext=fontfile=${escapeFilterPath(fontPath)}:text='ILUSTRASI PROMOSI - BUKAN FOTO PRODUK':fontcolor=0xcbd5e1:fontsize=18:x=(w-text_w)/2:y=1165`,
  "fade=t=in:st=0:d=0.4",
  "fade=t=out:st=11.4:d=0.6"
].join(",");

const assertProbe = (raw: string): void => {
  let parsed: ProbeResult;
  try { parsed = JSON.parse(raw) as ProbeResult; }
  catch { throw new Error("FFprobe returned invalid metadata."); }
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const duration = Number(parsed.format?.duration);
  if (video?.codec_name !== "h264" || video.width !== WIDTH || video.height !== HEIGHT ||
      video.pix_fmt !== "yuv420p" || video.avg_frame_rate !== `${FPS}/1` || !Number.isFinite(duration) ||
      duration < DURATION_SECONDS - 0.15 || duration > DURATION_SECONDS + 0.15) {
    throw new Error("Rendered video failed codec, resolution, pixel-format, or duration verification.");
  }
};

/**
 * Renders an abstract, text-led product promotion. It deliberately has no
 * storage, network, database, image-input, or publication dependencies.
 * The output is illustrative content, not a depiction of the actual product.
 */
export class IllustrativeProductVideoRenderer {
  private readonly maxOutputBytes: number;
  private readonly timeoutMs: number;
  private readonly runProcess: (binary: string, args: string[], timeoutMs: number) => Promise<void>;
  private readonly probeProcess: (binary: string, args: string[], timeoutMs: number) => Promise<string>;

  constructor(private readonly options: IllustrativeProductVideoRendererOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runProcess = options.runProcess ?? defaultRunProcess;
    this.probeProcess = options.probeProcess ?? defaultProbeProcess;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0 ||
        !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Illustrative video output and timeout limits must be positive safe integers.");
    }
  }

  async render(input: IllustrativeProductVideoInput): Promise<IllustrativeProductVideoResult> {
    if (!input || typeof input.productName !== "string" || !input.productName.trim()) {
      throw new TypeError("A product name is required.");
    }
    if (!Number.isSafeInteger(input.priceCents) || input.priceCents < 0) {
      throw new TypeError("Product price must be a non-negative safe integer.");
    }
    if (!/^[A-Z]{3}$/.test(input.currency)) {
      throw new TypeError("Currency must be a three-letter uppercase ISO code.");
    }
    // Validate currency support before creating temporary files.
    formatPrice(input.priceCents, input.currency);

    const workingDir = await mkdtemp(join(tmpdir(), "affiliateos-illustrative-video-"));
    try {
      const titlePath = join(workingDir, "title.txt");
      const pricePath = join(workingDir, "price.txt");
      const outputPath = join(workingDir, "illustrative-promo.mp4");
      await writeFile(titlePath, cleanText(input.productName, 52), { encoding: "utf8", flag: "wx" });
      await writeFile(pricePath, formatPrice(input.priceCents, input.currency), { encoding: "utf8", flag: "wx" });

      await this.runProcess(this.options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `color=c=0x0b1220:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${DURATION_SECONDS}`,
        "-vf", buildFilter(titlePath, pricePath, this.options.fontPath ?? FONT_PATH),
        "-t", String(DURATION_SECONDS), "-r", String(FPS),
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath
      ], this.timeoutMs);

      const outputStats = await stat(outputPath);
      if (!outputStats.isFile() || outputStats.size <= 0 || outputStats.size > this.maxOutputBytes) {
        throw new Error("Rendered illustrative video is empty or exceeds the configured output size limit.");
      }
      const bytes = await readFile(outputPath);
      if (!isStructurallyValidMedia("video/mp4", bytes)) {
        throw new Error("FFmpeg output is not a structurally valid MP4.");
      }

      const probeOutput = await this.probeProcess(this.options.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe", [
        "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate",
        "-show_entries", "format=duration", "-of", "json", outputPath
      ], this.timeoutMs);
      assertProbe(probeOutput);

      return {
        bytes: new Uint8Array(bytes),
        metadata: {
          mimeType: "video/mp4",
          width: WIDTH,
          height: HEIGHT,
          durationMs: DURATION_SECONDS * 1000,
          fps: FPS,
          codec: "h264",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteSize: bytes.byteLength
        }
      };
    } finally {
      await rm(workingDir, { recursive: true, force: true });
    }
  }
}
