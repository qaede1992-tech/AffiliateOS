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
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface MediaAssetRepository {
  listByContent(contentId: EntityId): Promise<MediaAsset[]>;
  findById(id: EntityId): Promise<MediaAsset | undefined>;
  save(asset: MediaAsset): Promise<MediaAsset>;
}

export const isPublicMediaUrl = (reference: string): boolean => {
  try {
    const url = new URL(reference);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
};

export const validateMediaAsset = (asset: MediaAsset): void => {
  if (!asset.reference.trim()) throw new Error("Media asset reference is required.");
  if (asset.source === "url" && !isPublicMediaUrl(asset.reference)) {
    throw new Error("URL media assets require an HTTPS URL.");
  }
  if (asset.byteSize !== undefined && (!Number.isSafeInteger(asset.byteSize) || asset.byteSize < 0)) {
    throw new Error("Media asset byteSize must be a non-negative integer.");
  }
};
