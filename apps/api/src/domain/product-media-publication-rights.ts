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

  // AI-edited derivatives require two independent approvals: rights to use
  // the source material and an audited human confirmation of product identity.
  // Rights verification alone must never make a generated product image publishable.
  if (
    asset.sourceProvider === "openai" &&
    asset.sourceUrl.startsWith("generated:openai-image-edit:") &&
    (
      asset.identityStatus !== "verified" ||
      !asset.identityReviewedBy?.trim() ||
      !asset.identityReviewedAt ||
      !asset.identityReviewReason?.trim()
    )
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
 * Re-checks product-linked media immediately before provider dispatch.
 * Product-linked content must use persisted rights-verified product assets;
 * non-product organic content retains its legacy content-scoped/external path. New product media must match a persisted rights row.
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
    // Product-linked promotional content must never fall back to untracked
    // content-scoped uploads: those objects have no persisted product-rights row.
    // Organic content without a linked product retains the legacy upload path.
    if (segments[0] !== "products") {
      if (linkedIds.size > 0) {
        throw new Error("Product-linked content cannot publish unverified content-scoped media; attach a rights-verified product asset.");
      }
      continue;
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
    if (matches.length === 0 && linkedIds.size === 0) continue;
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
 * An Instagram media container is created from scheduled content before final
 * publication. If content changes while the container is in flight, block the
 * final publish because the current media references may no longer describe it.
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


export interface PublicationMediaIntegritySnapshot {
  mediaAssets: Array<{ id:string; contentId:string; kind:string; source:string; reference:string; mimeType:string|null; byteSize:number|null; durationSeconds:number|null; widthPx:number|null; heightPx:number|null; hasAudio:boolean|null; createdAt:string; updatedAt:string }>;
  productMediaAssets: Array<{ id:string; productId:string; bucket:string; objectKey:string; mimeType:string; byteSize:number; sha256:string; sourceUrl:string; sourcePublisher:string|null; sourceProvider:string|null; sourceCandidateId:string|null }>;
}
export async function createPublicationMediaIntegritySnapshot(mediaAssets: MediaAsset[], linkedProductIds: string[], repository?: ProductMediaAssetRepository): Promise<PublicationMediaIntegritySnapshot> {
  const mediaSnapshot = mediaAssets.map(a => ({id:a.id,contentId:a.contentId,kind:a.kind,source:a.source,reference:a.reference,mimeType:a.mimeType??null,byteSize:a.byteSize??null,durationSeconds:a.durationSeconds??null,widthPx:a.widthPx??null,heightPx:a.heightPx??null,hasAudio:a.hasAudio??null,createdAt:a.createdAt,updatedAt:a.updatedAt})).sort((a,b)=>a.id.localeCompare(b.id));
  const uniqueProductIds=[...new Set(linkedProductIds)];
  if(uniqueProductIds.length && !repository) throw new Error("Product media repository is unavailable for immutable publication snapshot.");
  const products=repository&&uniqueProductIds.length ? repository.listByProducts ? await repository.listByProducts(uniqueProductIds) : (await Promise.all(uniqueProductIds.map(id=>repository.listByProduct(id)))).flat() : [];
  const matched=new Map<string,ProductMediaAsset>();
  for(const media of mediaAssets){
    const separator=media.reference.indexOf("/");
    const bucket=separator>0?media.reference.slice(0,separator):"";
    const key=separator>0?media.reference.slice(separator+1):"";
    const matches=products.filter(a=>media.source==="url"?a.sourceUrl===media.reference:media.source==="object-storage"&&a.bucket===bucket&&a.objectKey===key);
    if(matches.length>1) throw new Error("Publication media maps to ambiguous product-media records.");
    if(matches.length===1) matched.set(matches[0]!.id,matches[0]!);
    if(uniqueProductIds.length&&media.source==="url"&&matches.length!==1) throw new Error("Product-linked external media has no unique persisted product-media identity.");
    if(uniqueProductIds.length&&media.source==="object-storage"&&key.startsWith("products/")&&matches.length!==1) throw new Error("Product-scoped media has no unique persisted product-media identity.");
  }
  const productSnapshot=[...matched.values()].map(a=>({id:a.id,productId:a.productId,bucket:a.bucket,objectKey:a.objectKey,mimeType:a.mimeType,byteSize:a.byteSize,sha256:a.sha256,sourceUrl:a.sourceUrl,sourcePublisher:a.sourcePublisher,sourceProvider:a.sourceProvider??null,sourceCandidateId:a.sourceCandidateId??null})).sort((a,b)=>a.id.localeCompare(b.id));
  return {mediaAssets:mediaSnapshot,productMediaAssets:productSnapshot};
}
export function assertPublicationMediaIntegritySnapshot(expected: unknown,current: PublicationMediaIntegritySnapshot): void {
  if(!expected||typeof expected!=="object"||JSON.stringify(expected)!==JSON.stringify(current)) throw new Error("Instagram media identity or bytes changed after container creation; final publication is blocked.");
}
