import { createHash } from "node:crypto";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "./product-media-ingestion.js";
import type { PublicationDispatchReservationRepository } from "./publication-dispatch-reservation.js";
import { hasCurrentVerifiedRights, hasVerifiedProductIdentity } from "./product-media-publication-rights.js";
import { verifyProductMediaDeliveryToken, type ProductMediaDeliveryTokenConfig } from "./product-media-delivery-token.js";

export interface AuthorizedProductMediaDelivery {
  asset: ProductMediaAsset;
  bytes: Uint8Array;
}

/**
 * Authorizes one short-lived local-volume media request. Authorization is
 * deliberately bound to the active Instagram dispatch reservation and the
 * immutable asset ID list captured before dispatch.
 */
export async function authorizeProductMediaDelivery(input: {
  token: string;
  tokenConfig: ProductMediaDeliveryTokenConfig;
  assets: ProductMediaAssetRepository;
  reservations: PublicationDispatchReservationRepository;
  readLocal: (key: string, maxBytes: number) => Promise<Uint8Array>;
  maximumBytes: number;
  now?: number;
}): Promise<AuthorizedProductMediaDelivery> {
  const claims = verifyProductMediaDeliveryToken(input.token, input.tokenConfig, input.now);
  const asset = await input.assets.findById(claims.assetId);
  if (
    !asset ||
    asset.id !== claims.assetId ||
    asset.productId !== claims.productId ||
    asset.storageBackend !== "local_volume" ||
    asset.sha256.toLowerCase() !== claims.sha256.toLowerCase() ||
    !hasCurrentVerifiedRights(asset) ||
    !hasVerifiedProductIdentity(asset)
  ) throw new Error("Product media delivery is not authorized.");

  const reservation = await input.reservations.findById(claims.reservationId);
  if (
    !reservation ||
    reservation.provider !== "instagram-graph" ||
    reservation.contentId !== claims.contentId ||
    (reservation.state !== "dispatching" && reservation.state !== "accepted") ||
    !Array.isArray(reservation.snapshot.mediaAssetIds) ||
    !reservation.snapshot.mediaAssetIds.includes(asset.id)
  ) throw new Error("Product media delivery reservation is not active.");

  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0 || asset.byteSize > input.maximumBytes) {
    throw new Error("Product media delivery exceeds its configured byte limit.");
  }
  const bytes = await input.readLocal(asset.objectKey, input.maximumBytes);
  if (bytes.byteLength !== asset.byteSize || createHash("sha256").update(bytes).digest("hex") !== asset.sha256.toLowerCase()) {
    throw new Error("Product media delivery integrity verification failed.");
  }
  return { asset, bytes };
}
