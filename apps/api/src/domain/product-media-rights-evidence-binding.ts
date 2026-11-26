import type { ProductMediaAsset, ProductMediaRightsReviewCommand } from "./product-media-ingestion.js";

const normalizedHttpsUrl = (value: string | null | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
};

/**
 * Bind an administrator's rights decision to provenance already persisted for
 * this exact asset. This is a consistency gate, not an automated legal opinion:
 * the administrator must still inspect the evidence and attest to the decision.
 */
export const validateProductMediaRightsEvidenceBinding = (
  asset: ProductMediaAsset,
  review: ProductMediaRightsReviewCommand
): void => {
  if (review.status !== "verified") return;

  const evidenceUrl = normalizedHttpsUrl(review.rightsEvidenceUrl);
  if (!evidenceUrl) throw new Error("Rights verification requires a credential-free HTTPS evidence URL.");

  const publisher = review.sourcePublisher?.trim();
  if (!publisher) throw new Error("Rights verification requires the persisted source publisher.");
  if (asset.sourcePublisher?.trim() &&
      asset.sourcePublisher.trim().toLocaleLowerCase() !== publisher.toLocaleLowerCase()) {
    throw new Error("Rights verification publisher does not match the asset's recorded provenance.");
  }

  if (review.rightsBasis === "license" || review.rightsBasis === "public_domain") {
    const recordedLicense = asset.sourceLicense?.trim();
    const recordedLicenseUrl = normalizedHttpsUrl(asset.sourceLicenseUrl);
    if (!recordedLicense || !recordedLicenseUrl) {
      throw new Error("License-based verification requires license metadata recorded with this asset.");
    }
    const assetEvidenceUrls = [
      normalizedHttpsUrl(asset.sourceLandingPageUrl),
      recordedLicenseUrl
    ].filter((value): value is string => Boolean(value));
    if (!assetEvidenceUrls.includes(evidenceUrl)) {
      throw new Error("Rights evidence URL must match this asset's recorded source page or license URL.");
    }
  }

  if (review.rightsBasis === "user_owned" &&
      asset.sourceProvider !== "user_upload" &&
      !asset.sourceUrl.startsWith("user-upload://")) {
    throw new Error("User-owned rights can only be attested for an asset recorded as a user upload.");
  }

  if (!review.reason.trim() || review.reason.trim().length < 20) {
    throw new Error("Rights verification requires a specific review reason of at least 20 characters.");
  }
};
