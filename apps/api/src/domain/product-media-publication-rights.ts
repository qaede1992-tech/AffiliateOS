import type { MediaAsset } from "./media-asset.js";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "./product-media-ingestion.js";

const VERIFIED_BASES = new Set([
  "explicit_permission",
  "license",
  "public_domain",
  "user_owned",
  "platform_authorization"
]);

export const hasCurrentVerifiedRights = (asset: ProductMediaAsset): boolean => {
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
    const verifiedAt = Date.parse(asset.rightsVerifiedAt);
    return evidence.protocol === "https:" &&
      Boolean(evidence.hostname) &&
      !evidence.username &&
      !evidence.password &&
      Number.isFinite(verifiedAt) &&
      verifiedAt <= Date.now();
  } catch {
    return false;
  }
};

/**
 * Re-checks only product-scoped object-storage media immediately before
 * provider dispatch. Existing content-scoped uploads and externally hosted
 * media retain their pre-existing publisher path; they are not treated as
 * product-media assets. New product media must match a persisted rights row.
 */
export async function assertProductMediaRightsForPublication(
  mediaAssets: MediaAsset[],
  linkedProductIds: string[],
  repository?: ProductMediaAssetRepository
): Promise<void> {
  const linkedIds = new Set(linkedProductIds);
  const productScoped: Array<{ bucket: string; objectKey: string; productId: string }> = [];

  for (const media of mediaAssets) {
    // Preserve the established URL-media publishing path. Product discovery
    // persists product media into product-scoped storage, so it cannot rely on
    // this legacy URL branch to bypass the product-scoped rights check.
    if (media.source !== "object-storage") continue;
    const separator = media.reference.indexOf("/");
    if (separator <= 0 || separator === media.reference.length - 1) {
      throw new Error("Object-storage media reference is invalid; publication is blocked.");
    }
    const bucket = media.reference.slice(0, separator);
    const objectKey = media.reference.slice(separator + 1);
    const segments = objectKey.split("/");
    // Legacy content-scoped uploads continue through the existing resolver.
    // Only the new products/<productId>/ namespace is governed by this policy.
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
