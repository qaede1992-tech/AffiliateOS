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
 * Re-checks product-scoped object-storage media immediately before provider
 * dispatch. Only product-scoped objects with a persisted, currently verified
 * provenance row are accepted. Content-scoped and legacy object paths remain
 * blocked until their own auditable rights workflow exists.
 */
export async function assertProductMediaRightsForPublication(
  mediaAssets: MediaAsset[],
  linkedProductIds: string[],
  repository?: ProductMediaAssetRepository
): Promise<void> {
  const linkedIds = new Set(linkedProductIds);
  const productScoped: Array<{ bucket: string; objectKey: string; productId: string }> = [];

  for (const media of mediaAssets) {
    if (media.source === "url") {
      throw new Error("Externally hosted media has no persisted rights provenance; publication is blocked.");
    }
    if (media.source !== "object-storage") continue;
    const separator = media.reference.indexOf("/");
    if (separator <= 0 || separator === media.reference.length - 1) {
      throw new Error("Object-storage media reference is invalid; publication is blocked.");
    }
    const bucket = media.reference.slice(0, separator);
    const objectKey = media.reference.slice(separator + 1);
    const segments = objectKey.split("/");
    if (segments[0] !== "products") {
      throw new Error("Object-storage media has no verified product-rights provenance; publication is blocked.");
    }

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
