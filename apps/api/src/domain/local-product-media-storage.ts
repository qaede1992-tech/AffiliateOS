import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface ProductMediaLocalStorageConfig {
  rootDirectory: string;
  maxImageBytes: number;
  maxVideoBytes: number;
}

export interface ProductMediaStoredObject {
  backend: "local_volume";
  bucket: "local-volume";
  key: string;
  sha256: string;
  byteSize: number;
}

const MIME_EXTENSION: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4"
};

const isInside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

/**
 * Persistent-volume adapter for ordinary product images and videos.
 *
 * The configured directory MUST be mounted to durable storage by the runtime.
 * This class intentionally does not expose public URLs or signed URLs: delivery
 * must be mediated by an authenticated API route that revalidates publication
 * rights and dispatch reservations before streaming bytes to a social provider.
 */
export class LocalProductMediaStorage {
  private readonly rootDirectory: string;

  get bucketName(): string {
    return "local-volume";
  }

  constructor(private readonly config: ProductMediaLocalStorageConfig) {
    if (!isAbsolute(config.rootDirectory)) throw new Error("Product media storage root must be an absolute path.");
    this.rootDirectory = resolve(config.rootDirectory);
    for (const [name, value] of Object.entries({
      maxImageBytes: config.maxImageBytes,
      maxVideoBytes: config.maxVideoBytes
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Product media storage ${name} must be a positive safe integer.`);
      }
    }
  }

  private async ensureRoot(): Promise<string> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.rootDirectory);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error("Product media storage root must be a real directory, not a symlink.");
    }
    const canonicalRoot = await realpath(this.rootDirectory);
    if (canonicalRoot !== this.rootDirectory) {
      throw new Error("Product media storage root must not resolve through a symlink.");
    }
    return canonicalRoot;
  }

  private resolveKey(root: string, key: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|mp4)$/i.test(key)) {
      throw new Error("Invalid opaque product media storage key.");
    }
    const target = resolve(root, key);
    if (!isInside(root, target) || dirname(target) !== root) {
      throw new Error("Product media storage key escapes its configured root.");
    }
    return target;
  }

  async upload(input: {
    /** Requested provider key is intentionally ignored; local keys are opaque UUIDs. */
    key?: string;
    bytes: Uint8Array;
    contentType: string;
    upsert?: boolean;
  }): Promise<ProductMediaStoredObject> {
    const kind = input.contentType.startsWith("image/") ? "image" : "video";
    const extension = MIME_EXTENSION[input.contentType];
    if (!extension) {
      throw new Error("Product media MIME type does not match its declared kind.");
    }
    const limit = kind === "video" ? this.config.maxVideoBytes : this.config.maxImageBytes;
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > limit) {
      throw new Error("Product media bytes are empty or exceed the configured storage limit.");
    }

    const root = await this.ensureRoot();
    const key = `${randomUUID()}${extension}`;
    const target = this.resolveKey(root, key);
    const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(target, { force: true });
      throw error;
    }
    await handle.close();

    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== input.bytes.byteLength) {
      await rm(target, { force: true });
      throw new Error("Persisted product media failed its post-write integrity check.");
    }
    return {
      backend: "local_volume",
      bucket: "local-volume",
      key,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      byteSize: info.size
    };
  }

  async read(key: string, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Product media read limit must be a positive safe integer.");
    const root = await this.ensureRoot();
    const target = this.resolveKey(root, key);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maxBytes) {
      throw new Error("Product media file is missing, unsafe, empty, or exceeds the read limit.");
    }
    const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.size !== info.size) throw new Error("Product media changed while opening.");
      const bytes = new Uint8Array(openedInfo.size);
      const result = await handle.read(bytes, 0, bytes.byteLength, 0);
      if (result.bytesRead !== bytes.byteLength) throw new Error("Product media read was incomplete.");
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async remove(key: string): Promise<void> {
    const root = await this.ensureRoot();
    const target = this.resolveKey(root, key);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("Refusing to remove a non-regular product media file.");
      await rm(target, { force: false });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }

  async download(key: string, maxBytes: number): Promise<Uint8Array> {
    return this.read(key, maxBytes);
  }

  async inspect(key: string): Promise<{ byteSize: number; modifiedAt: Date }> {
    const root = await this.ensureRoot();
    const target = this.resolveKey(root, key);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Product media storage object is not a regular file.");
    return { byteSize: info.size, modifiedAt: info.mtime };
  }
}
