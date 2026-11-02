import type { MediaAsset } from "./media-asset.js";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "./product-media-ingestion.js";

const VERIFIED_BASES = new Set([
  "explicit_permission",
  "license",
  "public_domain",
  "user_owned",
  "platform_authorization"
]);

const hasCurrentVerifiedRights = (asset: ProductMediaAsset): boolean => {
  if (
    asset.rightsStatus !== "verified" ||
    !asset.rightsBasis ||
    !VERIFIED_BASES.has(asset.rightsBasis) ||
    !asset.rightsEvidenceUrl ||
    !asset.rightsVerifiedAt ||
    !asset.sourcePublisher?.trim()
  ) return false;

  try {
    const evidence = new URL(asset.rightsEvidenceUrl);
    return evidence.protocol === "https:" &&
      Boolean(evidence.hostname) &&
      Number.isFinite(Date.parse(asset.rightsVerifiedAt));
  } catch {
    return false;
  }
};

/**
 * Re-checks product-scoped object-storage media immediately before provider
 * dispatch. Content-scoped uploads are handled by the separate content-owned
 * media workflow; product-scoped objects must match a persisted product media
 * row and its current verified rights state.
 */
export async function assertProductMediaRightsForPublication(
  mediaAssets: MediaAsset[],
  linkedProductIds: string[],
  repository?: ProductMediaAssetRepository
): Promise<void> {
  const linkedIds = new Set(linkedProductIds);
  const productScoped: Array<{ bucket: string; objectKey: string; productId: string }> = [];

  for (const media of mediaAssets) {
    if (media.source === "url" && linkedIds.size > 0) {
      throw new Error("Externally hosted media has no persisted product-rights record; publication is blocked.");
    }
    if (media.source !== "object-storage") continue;
    const separator = media.reference.indexOf("/");
    if (separator <= 0 || separator === media.reference.length - 1) continue;
    const bucket = media.reference.slice(0, separator);
    const objectKey = media.reference.slice(separator + 1);
    const segments = objectKey.split("/");
    if (segments[0] !== "products") continue;

    const productId = segments[1] ?? "";
    if (!productId || !linkedIds.has(productId)) {
      throw new Error("Product media is not linked to the publishing content.");
    }
    if (segments.length < 3 || segments.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
      throw new Error("Product media object reference is invalid.");
    }
    productScoped.push({ bucket, objectKey, productId });
  }

  if (productScoped.length === 0) return;
  if (!repository) {
    throw new Error("Product media rights repository is unavailable; publication is blocked.");
  }

  const productIds = [...new Set(productScoped.map((asset) => asset.productId))];
  const persisted = repository.listByProducts
    ? await repository.listByProducts(productIds)
    : (await Promise.all(productIds.map((id) => repository.listByProduct(id)))).flat();

  for (const candidate of productScoped) {
    const matches = persisted.filter((asset) =>
      asset.productId === candidate.productId &&
      asset.bucket === candidate.bucket &&
      asset.objectKey === candidate.objectKey
    );
    if (matches.length !== 1 || !hasCurrentVerifiedRights(matches[0]!)) {
      throw new Error("Product media rights are missing, ambiguous, unverified, or revoked; publication is blocked.");
    }
  }
}
