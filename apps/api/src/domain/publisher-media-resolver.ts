import type { Content } from "@affiliateos/shared";
import type { MediaAsset } from "./media-asset.js";
import type { SupabaseStorageClient } from "./supabase-storage.js";

const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Converts private Supabase object references into short-lived HTTPS URLs at the
 * last responsible moment before a publisher call. Persisted metadata is never
 * rewritten, and existing HTTPS URL assets remain unchanged.
 */
export async function resolvePublisherMediaAssets(
  content: Pick<Content, "id">,
  assets: MediaAsset[],
  storage?: Pick<SupabaseStorageClient, "bucketName" | "createSignedUrl">,
  allowedProductIds: string[] = []
): Promise<MediaAsset[]> {
  return Promise.all(assets.map(async (asset) => {
    if (asset.source !== "object-storage") return asset;
    if (!storage) {
      throw new Error("Private media publishing requires configured Supabase Storage.");
    }
    if (asset.contentId !== content.id) {
      throw new Error("Private media asset does not belong to the publishing content.");
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
    let parsed: URL;
    try {
      parsed = new URL(signedUrl);
    } catch {
      throw new Error("Storage returned an invalid signed media URL.");
    }
    if (parsed.protocol !== "https:" || !parsed.hostname) {
      throw new Error("Storage returned a signed media URL that is not public HTTPS.");
    }

    return { ...asset, source: "url" as const, reference: parsed.toString() };
  }));
}
