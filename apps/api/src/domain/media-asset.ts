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

/**
 * Applies a syntactic guard to publisher-facing media URLs. Network fetchers
 * must still validate and pin DNS answers before downloading remote content.
 */
export const isPublicMediaUrl = (reference: string): boolean => {
  try {
    const url = new URL(reference);
    const rawHostname = url.hostname.toLowerCase();
    const withoutBrackets = rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
    const hostname = withoutBrackets.endsWith(".")
      ? withoutBrackets.slice(0, -1)
      : withoutBrackets;
    const localOnlyHostname = hostname === "localhost" ||
      hostname === "home.arpa" ||
      [".localhost", ".local", ".internal", ".invalid", ".lan", ".home.arpa", ".test", ".example"]
        .some((suffix) => hostname.endsWith(suffix));

    return url.protocol === "https:" &&
      Boolean(hostname) &&
      hostname.includes(".") &&
      !url.username &&
      !url.password &&
      isIP(hostname) === 0 &&
      !localOnlyHostname;
  } catch {
    return false;
  }
};

export const validateMediaAsset = (asset: MediaAsset): void => {
  if (!asset.reference.trim()) throw new Error("Media asset reference is required.");
  if (asset.source === "url" && !isPublicMediaUrl(asset.reference)) {
    throw new Error("URL media assets require a credential-free public HTTPS URL.");
  }
  if (asset.byteSize !== undefined && (!Number.isSafeInteger(asset.byteSize) || asset.byteSize < 0)) {
    throw new Error("Media asset byteSize must be a non-negative integer.");
  }
  if (asset.durationSeconds !== undefined && (!Number.isSafeInteger(asset.durationSeconds) || asset.durationSeconds < 0)) {
    throw new Error("Media asset durationSeconds must be a non-negative integer.");
  }
};
