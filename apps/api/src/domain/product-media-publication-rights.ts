import type { MediaAsset } from "./media-asset.js";
import type { PublicationOperation } from "./publication-operation.js";
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
  const externalUrls: string[] = [];

  for (const media of mediaAssets) {
    if (media.source === "url") {
      externalUrls.push(media.reference);
      continue;
    }
    if (media.source !== "object-storage") continue;
    const separator = media.reference.indexOf("/");
    if (separator <= 0 || separator === media.reference.length - 1) {
      throw new Error("Object-storage media reference is invalid; publication is blocked.");
    }
    const bucket = media.reference.slice(0, separator);
    const objectKey = media.reference.slice(separator + 1);
    const segments = objectKey.split("/");
    // Existing content-scoped and other legacy storage namespaces keep
    // their established publisher path. Only products/<productId>/ assets
    // created by the product-media ingestion workflow use this rights gate.
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

  const productIds = [...new Set([
    ...productScoped.map((asset) => asset.productId),
    ...linkedProductIds
  ])];
  const persisted = repository && productIds.length > 0
    ? repository.listByProducts
      ? await repository.listByProducts(productIds)
      : (await Promise.all(productIds.map((id) => repository.listByProduct(id)))).flat()
    : [];

  // Legacy content URLs remain compatible unless the URL is also registered
  // as a source for one of the linked products. Registered product-source URLs
  // must pass the same persisted provenance check as product-scoped objects.
  for (const reference of externalUrls) {
    const matches = persisted.filter((asset) =>
      linkedIds.has(asset.productId) && asset.sourceUrl === reference
    );
    if (matches.length === 0) continue;
    if (matches.length !== 1 || !hasCurrentVerifiedRights(matches[0]!)) {
      throw new Error("Product media rights are missing, ambiguous, unverified, or revoked; publication is blocked.");
    }
  }

  if (productScoped.length === 0) return;
  if (!repository) {
    throw new Error("Product media rights repository is unavailable; publication is blocked.");
  }

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


/**
 * The Instagram container is created from the scheduled content before final
 * publication. If that content changes while the container is in flight, the
 * current media references may no longer describe the container being published.
 * Block the final dispatch rather than validating a different set of assets.
 */
export function assertContentUnchangedSincePublicationOperation(
  content: Pick<{ updatedAt: string }, "updatedAt">,
  operation: Pick<PublicationOperation, "createdAt">
): void {
  const contentUpdatedAt = Date.parse(content.updatedAt);
  const operationCreatedAt = Date.parse(operation.createdAt);
  if (!Number.isFinite(contentUpdatedAt) || !Number.isFinite(operationCreatedAt) || contentUpdatedAt > operationCreatedAt) {
    throw new Error("Content changed after Instagram media container creation; final publication is blocked.");
  }
}
