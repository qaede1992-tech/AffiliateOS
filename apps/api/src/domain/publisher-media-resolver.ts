import type { Content } from "@affiliateos/shared";
import { validateMediaAsset, type MediaAsset } from "./media-asset.js";
import type { SupabaseStorageClient } from "./supabase-storage.js";

const SIGNED_URL_TTL_SECONDS = 60 * 60;

export type PublisherMediaResolutionOptions = {
  /** Exact media IDs already approved by the generated-creative publication guard. */
  generatedMediaAssetIds?: ReadonlySet<string>;
  /** Returns the narrow HMAC-backed local-volume URL for an approved generated asset. */
  resolveGeneratedMediaUrl?: (asset: MediaAsset, contentId: string) => Promise<string>;
};

/**
 * Resolves ordinary private objects through Supabase and approved generated
 * illustrative assets through their dedicated local-volume delivery route.
 * Generated media never falls through to Supabase Storage.
 */
export async function resolvePublisherMediaAssets(
  content: Pick<Content, "id">,
  assets: MediaAsset[],
  storage?: Pick<SupabaseStorageClient, "bucketName" | "createSignedUrl">,
  allowedProductIds: string[] = [],
  options: PublisherMediaResolutionOptions = {}
): Promise<MediaAsset[]> {
  return Promise.all(assets.map(async (asset) => {
    validateMediaAsset(asset);
    if (asset.source !== "object-storage") return asset;
    if (asset.contentId !== content.id) {
      throw new Error("Private media asset does not belong to the publishing content.");
    }

    if (options.generatedMediaAssetIds?.has(asset.id)) {
      if (asset.kind !== "video" || asset.mimeType !== "video/mp4" ||
          !asset.reference.startsWith(`affiliate-media/content/${content.id}/`)) {
        throw new Error("Approved generated media does not match its content-scoped MP4 identity.");
      }
      if (!options.resolveGeneratedMediaUrl) {
        throw new Error("Approved generated media requires the dedicated local-volume delivery resolver.");
      }
      const reference = await options.resolveGeneratedMediaUrl(asset, content.id);
      const resolvedAsset = { ...asset, source: "url" as const, reference };
      validateMediaAsset(resolvedAsset);
      return resolvedAsset;
    }

    if (!storage) {
      throw new Error("Private media publishing requires configured Supabase Storage.");
    }
    const separator = asset.reference.indexOf("/");
    if (separator <= 0 || separator === asset.reference.length - 1) {
      throw new Error("Private media reference must contain a bucket and object key.");
    }
    const bucket = asset.reference.slice(0, separator);
    const key = asset.reference.slice(separator + 1);
    if (bucket !== storage.bucketName) {
      throw new Error("Private media asset references an unexpected Storage bucket.");
    }
    const segments = key.split("/");
    const contentScoped = key.startsWith(`content/${content.id}/`);
    const productScoped = segments.length >= 3 && segments[0] === "products" &&
      allowedProductIds.includes(segments[1] ?? "") &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segments[1] ?? "");
    if ((!contentScoped && !productScoped) ||
        segments.some((part) => !part || part.includes(String.fromCharCode(92)) || part === "." || part === "..")) {
      throw new Error("Private media object key is outside the publishing content or linked-product scope.");
    }

    const signedUrl = await storage.createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
    const resolvedAsset = { ...asset, source: "url" as const, reference: signedUrl };
    validateMediaAsset(resolvedAsset);
    return resolvedAsset;
  }));
}
