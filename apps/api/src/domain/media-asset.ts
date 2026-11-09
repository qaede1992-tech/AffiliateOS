import { isIP } from "node:net";
import type { EntityId, IsoTimestamp } from "@affiliateos/shared";

export type MediaAssetKind = "video" | "image" | "thumbnail";
export type MediaAssetSource = "url" | "object-storage";

export interface MediaAsset {
  id: EntityId;
  contentId: EntityId;
  kind: MediaAssetKind;
  source: MediaAssetSource;
  reference: string;
  mimeType?: string;
  byteSize?: number;
  durationSeconds?: number;
  widthPx?: number;
  heightPx?: number;
  hasAudio?: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface MediaAssetRepository {
  listByContent(contentId: EntityId): Promise<MediaAsset[]>;
  findById(id: EntityId): Promise<MediaAsset | undefined>;
  save(asset: MediaAsset): Promise<MediaAsset>;
}

const LOCAL_OR_SPECIAL_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".test",
  ".example",
  ".invalid",
  ".onion"
] as const;

/**
 * Performs conservative URL-shape validation for externally hosted media.
 * This does not validate DNS answers or redirects; network fetchers must still
 * pin validated public addresses and revalidate every redirect before connecting.
 */
export const isPublicMediaUrl = (reference: string): boolean => {
  try {
    const url = new URL(reference);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return false;

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!hostname || !hostname.includes(".") || isIP(hostname) !== 0) return false;
    if (hostname === "localhost" || LOCAL_OR_SPECIAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

export const validateMediaAsset = (asset: MediaAsset): void => {
  if (!asset.reference.trim()) throw new Error("Media asset reference is required.");
  if (asset.source === "url" && !isPublicMediaUrl(asset.reference)) {
    throw new Error("URL media assets require a credential-free public HTTPS hostname.");
  }
  if (asset.byteSize !== undefined && (!Number.isSafeInteger(asset.byteSize) || asset.byteSize < 0)) {
    throw new Error("Media asset byteSize must be a non-negative integer.");
  }
  if (asset.durationSeconds !== undefined && (!Number.isSafeInteger(asset.durationSeconds) || asset.durationSeconds < 0)) {
    throw new Error("Media asset durationSeconds must be a non-negative integer.");
  }
};
