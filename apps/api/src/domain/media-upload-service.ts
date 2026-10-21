import { randomUUID } from "node:crypto";
import type { MediaAsset, MediaAssetKind, MediaAssetRepository } from "./media-asset.js";
import type { SupabaseStorageClient } from "./supabase-storage.js";

export interface MediaUploadContentReader {
  get(id: string): Promise<{ id: string } | undefined>;
}

export interface MediaUploadInput {
  contentId: string;
  kind: MediaAssetKind;
  mimeType: string;
  bytes: Uint8Array;
  durationSeconds?: number;
}

export interface MediaUploadPolicy {
  maxImageBytes: number;
  maxVideoBytes: number;
}

const allowedTypes: Record<MediaAssetKind, readonly string[]> = {
  image: ["image/jpeg", "image/png", "image/webp"],
  thumbnail: ["image/jpeg", "image/png", "image/webp"],
  video: ["video/mp4"]
};

const matchesSignature = (mimeType: string, bytes: Uint8Array): boolean => {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (mimeType === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (mimeType === "video/mp4") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
  return false;
};

const extensionByType: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4"
};

export class MediaUploadService {
  constructor(
    private readonly contentReader: MediaUploadContentReader,
    private readonly mediaAssets: MediaAssetRepository,
    private readonly storage: SupabaseStorageClient,
    private readonly policy: MediaUploadPolicy
  ) {
    for (const [name, value] of Object.entries(policy)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Media upload policy ${name} must be a positive safe integer.`);
    }
  }

  async uploadStream(input: {
    contentId: string;
    kind: MediaAssetKind;
    mimeType: string;
    body: ReadableStream<Uint8Array>;
    contentLength: number;
    signal?: AbortSignal;
    durationSeconds?: number;
  }): Promise<MediaAsset> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.contentId)) throw new Error("A valid content UUID is required.");
    const content = await this.contentReader.get(input.contentId);
    if (!content) throw new Error("Media upload content does not exist.");
    if (!allowedTypes[input.kind]?.includes(input.mimeType)) throw new Error("Media type is not allowed for this asset kind.");
    const limit = input.kind === "video" ? this.policy.maxVideoBytes : this.policy.maxImageBytes;
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0 || input.contentLength > limit) throw new Error("Media upload exceeds the configured size limit.");
    if (input.durationSeconds !== undefined && (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds < 0)) throw new Error("Media duration must be a non-negative integer.");

    const reader = input.body.getReader();
    let total = 0;
    let prefix = new Uint8Array(0);
    let validated = false;
    let ended = false;
    const boundedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (input.signal?.aborted) throw new Error("Media upload was cancelled.");
          const result = await reader.read();
          if (result.done) {
            ended = true;
            if (total !== input.contentLength) throw new Error("Media upload length does not match Content-Length.");
            if (!validated || !matchesSignature(input.mimeType, prefix)) throw new Error("Media content does not match its declared MIME type.");
            controller.close();
            return;
          }
          const chunk = result.value;
          total += chunk.byteLength;
          if (total > limit || total > input.contentLength) throw new Error("Media upload exceeds the configured size limit.");
          if (!validated) {
            const needed = Math.max(0, 12 - prefix.byteLength);
            const head = chunk.slice(0, needed);
            const combined = new Uint8Array(prefix.byteLength + head.byteLength);
            combined.set(prefix);
            combined.set(head, prefix.byteLength);
            prefix = combined;
            if (prefix.byteLength >= 12) {
              if (!matchesSignature(input.mimeType, prefix)) throw new Error("Media content does not match its declared MIME type.");
              validated = true;
            }
          }
          controller.enqueue(chunk);
        } catch (error) {
          try { await reader.cancel(); } catch {}
          controller.error(error);
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } catch {}
      }
    });

    const id = randomUUID();
    const now = new Date().toISOString();
    const key = `content/${input.contentId}/${id}.${extensionByType[input.mimeType]}`;
    let stored: { bucket: string; key: string } | undefined;
    try {
      stored = await this.storage.uploadStream({ key, body: boundedBody, contentType: input.mimeType, contentLength: input.contentLength, signal: input.signal });
      if (!ended || total !== input.contentLength) throw new Error("Media stream did not complete.");
      const asset: MediaAsset = {
        id, contentId: input.contentId, kind: input.kind, source: "object-storage",
        reference: `${stored.bucket}/${stored.key}`, mimeType: input.mimeType, byteSize: total,
        ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
        createdAt: now, updatedAt: now
      };
      return await this.mediaAssets.save(asset);
    } catch (error) {
      if (stored) {
        try { await this.storage.remove(stored.key); } catch {}
      }
      throw error;
    }
  }

  async upload(input: MediaUploadInput): Promise<MediaAsset> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.contentId)) throw new Error("A valid content UUID is required.");
    const content = await this.contentReader.get(input.contentId);
    if (!content) throw new Error("Media upload content does not exist.");
    if (!allowedTypes[input.kind]?.includes(input.mimeType)) throw new Error("Media type is not allowed for this asset kind.");
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) throw new Error("Media upload must contain non-empty bytes.");
    const limit = input.kind === "video" ? this.policy.maxVideoBytes : this.policy.maxImageBytes;
    if (input.bytes.byteLength > limit) throw new Error("Media upload exceeds the configured size limit.");
    if (!matchesSignature(input.mimeType, input.bytes)) throw new Error("Media content does not match its declared MIME type.");
    if (input.durationSeconds !== undefined && (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds < 0)) {
      throw new Error("Media duration must be a non-negative integer.");
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const key = `content/${input.contentId}/${id}.${extensionByType[input.mimeType]}`;
    const stored = await this.storage.upload({ key, bytes: input.bytes, contentType: input.mimeType });
    const asset: MediaAsset = {
      id,
      contentId: input.contentId,
      kind: input.kind,
      source: "object-storage",
      reference: `${stored.bucket}/${stored.key}`,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
      createdAt: now,
      updatedAt: now
    };

    try {
      return await this.mediaAssets.save(asset);
    } catch (error) {
      // Best-effort compensation: don't leave an orphaned object if metadata persistence fails.
      try {
        await this.storage.remove(stored.key);
      } catch {
        // Preserve the metadata persistence error; orphan cleanup can reconcile failed compensation later.
      }
      throw error;
    }
  }
}
