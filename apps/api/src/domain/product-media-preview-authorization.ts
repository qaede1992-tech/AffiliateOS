import { createHash } from "node:crypto";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "./product-media-ingestion.js";
import { verifyProductMediaPreviewToken, type ProductMediaPreviewTokenConfig } from "./product-media-preview-token.js";

export async function authorizeProductMediaPreview(input: {
  token: string;
  tokenConfig: ProductMediaPreviewTokenConfig;
  assets: ProductMediaAssetRepository;
  readLocal: (key: string, maximumBytes: number) => Promise<Uint8Array>;
  maximumBytes: number;
  now?: number;
}): Promise<{ asset: ProductMediaAsset; bytes: Uint8Array }> {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0) {
    throw new Error("Product media preview byte limit must be a positive safe integer.");
  }
  const claims = verifyProductMediaPreviewToken(input.token, input.tokenConfig, input.now);
  const asset = await input.assets.findById(claims.assetId);
  if (!asset ||
      asset.productId !== claims.productId ||
      asset.storageBackend !== "local_volume" ||
      asset.bucket !== "local-volume" ||
      asset.sha256 !== claims.sha256 ||
      !Number.isSafeInteger(asset.byteSize) ||
      asset.byteSize <= 0 ||
      asset.byteSize > input.maximumBytes) {
    throw new Error("Product media preview asset is unavailable.");
  }
  const bytes = await input.readLocal(asset.objectKey, input.maximumBytes);
  if (bytes.byteLength !== asset.byteSize ||
      createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new Error("Product media preview integrity verification failed.");
  }
  return { asset, bytes };
}
