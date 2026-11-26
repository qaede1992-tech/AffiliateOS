import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, mkdir, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { isStructurallyValidMedia } from "./media-file-validation.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Opaque, relative identifier; never an absolute filesystem path. */
export interface IllustrativeCreativeFile {
  key: string;
  sha256: string;
  byteSize: number;
}

export interface IllustrativeCreativeFileStoreOptions {
  rootDirectory: string;
  maxBytes?: number;
}

/**
 * Local persistent-volume adapter for generated illustrative MP4 files.
 *
 * This adapter deliberately has no Supabase, network, database, or publication
 * dependencies. Callers must persist the returned relative key and must not
 * expose it directly as a public URL.
 */
export class IllustrativeCreativeFileStore {
  private readonly root: string;
  private readonly maxBytes: number;

  constructor(options: IllustrativeCreativeFileStoreOptions) {
    if (!options.rootDirectory?.trim()) throw new Error("Illustrative media directory is required.");
    this.root = resolve(options.rootDirectory);
    this.maxBytes = options.maxBytes ?? 12 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error("Illustrative media size limit must be a positive safe integer.");
    }
  }

  private keyFor(creativeId: string, sha256: string): string {
    if (!UUID_PATTERN.test(creativeId)) throw new Error("A valid creative UUID is required.");
    if (!SHA256_PATTERN.test(sha256)) throw new Error("A valid SHA-256 digest is required.");
    return `${creativeId.toLowerCase()}-${sha256}.mp4`;
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Illustrative media root must be a real directory, not a symbolic link.");
    }
  }

  async put(input: { creativeId: string; bytes: Uint8Array; expectedSha256: string }): Promise<IllustrativeCreativeFile> {
    const key = this.keyFor(input.creativeId, input.expectedSha256);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > this.maxBytes) {
      throw new Error("Illustrative media must be non-empty and within the configured size limit.");
    }
    if (!isStructurallyValidMedia("video/mp4", input.bytes)) {
      throw new Error("Illustrative media must be a structurally valid MP4 file.");
    }
    const actualSha256 = createHash("sha256").update(input.bytes).digest("hex");
    if (actualSha256 !== input.expectedSha256) throw new Error("Illustrative media SHA-256 does not match its metadata.");

    await this.ensureRoot();
    const destination = join(this.root, key);
    const handle = await open(destination, "wx", 0o600);
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } catch (error) {
      await handle.close();
      try { await unlink(destination); } catch {}
      throw error;
    }
    await handle.close();
    return { key, sha256: actualSha256, byteSize: input.bytes.byteLength };
  }

  async get(input: { key: string; expectedSha256: string; expectedByteSize: number }): Promise<Uint8Array> {
    if (!SHA256_PATTERN.test(input.expectedSha256)) throw new Error("A valid SHA-256 digest is required.");
    if (!Number.isSafeInteger(input.expectedByteSize) || input.expectedByteSize <= 0 || input.expectedByteSize > this.maxBytes) {
      throw new Error("Illustrative media byte size is outside the configured limit.");
    }
    // Re-derive the only permitted filename format; callers cannot choose a path.
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([a-f0-9]{64})\.mp4$/i.exec(input.key);
    if (!match || match[2] !== input.expectedSha256) throw new Error("Invalid illustrative media key.");
    await this.ensureRoot();
    const path = join(this.root, input.key);
    // Open without following symlinks, then validate the opened descriptor.
    // This avoids a lstat/open race where the path is swapped after lstat.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== input.expectedByteSize || info.size > this.maxBytes) {
        throw new Error("Stored illustrative media does not match its expected file metadata.");
      }
      const bytes = await handle.readFile();
      if (!isStructurallyValidMedia("video/mp4", bytes)) {
        throw new Error("Stored illustrative media is not a structurally valid MP4 file.");
      }
      if (createHash("sha256").update(bytes).digest("hex") !== input.expectedSha256) {
        throw new Error("Stored illustrative media failed SHA-256 verification.");
      }
      return new Uint8Array(bytes);
    } finally {
      await handle.close();
    }
  }

  async remove(key: string): Promise<void> {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([a-f0-9]{64})\.mp4$/i.exec(key);
    if (!match) throw new Error("Invalid illustrative media key.");
    await this.ensureRoot();
    const path = join(this.root, key);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Stored illustrative media must be a regular file.");
    await unlink(path);
  }
}
