import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStructurallyValidMedia } from "./media-file-validation.js";

const execFile = promisify(execFileCallback);
const DEFAULT_MAX_DURATION_SECONDS = 30;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;

// FFmpeg resource limits are per process. Keep at most one transcode active
// in this Node.js process so concurrent product ingestions cannot multiply them.
let activeTranscode = false;


export interface WebmTranscodeOptions {
  maxInputBytes: number;
  maxOutputBytes?: number;
  maxDurationSeconds?: number;
  timeoutMs?: number;
  ffmpegPath?: string;
  /** Test seam. Production invokes FFmpeg with execFile (never a shell). */
  runProcess?: (binary: string, args: string[], timeoutMs: number) => Promise<void>;
}

const defaultRunProcess = async (binary: string, args: string[], timeoutMs: number): Promise<void> => {
  await execFile(binary, args, {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_STDERR_BYTES,
    windowsHide: true
  });
};

export const hasWebmEbmlSignature = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= 4 &&
  bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;

/**
 * Convert a bounded, already-downloaded WebM file using only local file input.
 * This does not fetch URLs, alter rights status, or assert product identity.
 */
export const transcodeWebmToMp4 = async (
  input: Uint8Array,
  options: WebmTranscodeOptions
): Promise<Uint8Array> => {
  const maxInputBytes = options.maxInputBytes;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxDurationSeconds = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (const [name, value] of Object.entries({ maxInputBytes, maxOutputBytes, maxDurationSeconds, timeoutMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`WebM transcode ${name} must be a positive safe integer.`);
    }
  }
  if (input.byteLength === 0 || input.byteLength > maxInputBytes) {
    throw new Error("WebM input is empty or exceeds the configured size limit.");
  }
  if (!hasWebmEbmlSignature(input)) {
    throw new Error("Downloaded video does not have a WebM/EBML signature.");
  }

  if (activeTranscode) {
    throw new Error("A WebM transcode is already active in this process.");
  }
  activeTranscode = true;
  try {
  const deadlineAt = Date.now() + timeoutMs;
  const runProcess = options.runProcess ?? defaultRunProcess;
  const runWithinDeadline = async (args: string[]): Promise<void> => {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error("WebM transcode exceeded its total time limit.");
    await runProcess(options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg", args, remainingMs);
  };

  const workingDir = await mkdtemp(join(tmpdir(), "affiliateos-webm-"));
  try {
    const inputPath = join(workingDir, "source.webm");
    const outputPath = join(workingDir, "converted.mp4");
    await writeFile(inputPath, input, { flag: "wx", mode: 0o600 });

    const args = [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-protocol_whitelist", "file,pipe",
      "-max_alloc", "67108864", "-max_pixels", "8294400",
      "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1",
      "-i", inputPath,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-sn", "-dn", "-t", String(maxDurationSeconds),
      "-vf", "scale=w='trunc(min(1280,iw)/2)*2':h='trunc(min(1280,ih)/2)*2':force_original_aspect_ratio=decrease",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
      "-pix_fmt", "yuv420p", "-threads", "1",
      "-c:a", "aac", "-b:a", "96k",
      "-map_metadata", "-1", "-movflags", "+faststart",
      "-fs", String(maxOutputBytes), outputPath
    ];
    await runWithinDeadline(args);

    const outputStats = await stat(outputPath);
    if (!outputStats.isFile() || outputStats.size <= 0 || outputStats.size >= maxOutputBytes) {
      throw new Error("Converted MP4 is empty or exceeds the configured output size limit.");
    }
    const output = new Uint8Array(await readFile(outputPath));
    if (!isStructurallyValidMedia("video/mp4", output)) {
      throw new Error("FFmpeg output is not a structurally valid MP4.");
    }

    // A box-level check alone can accept an MP4 whose media payload is truncated.
    // Decode the complete video stream to a null muxer before accepting the file.
    await runWithinDeadline([
      "-hide_banner", "-nostdin", "-v", "error", "-xerror",
      "-protocol_whitelist", "file,pipe",
      "-max_alloc", "67108864", "-max_pixels", "8294400",
      "-threads", "1", "-filter_threads", "1", "-i", outputPath,
      "-map", "0:v:0", "-f", "null", "-"
    ]);
    return output;
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
  } finally {
    activeTranscode = false;
  }
};
