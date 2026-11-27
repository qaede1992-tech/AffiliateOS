import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "../../src/domain/product-media-ingestion.js";
import { authorizeProductMediaPreview } from "../../src/domain/product-media-preview-authorization.js";
import { createProductMediaPreviewToken, type ProductMediaPreviewTokenConfig } from "../../src/domain/product-media-preview-token.js";

const now = Date.parse("2026-11-27T00:00:00.000Z");
const bytes = new Uint8Array([1, 2, 3, 4, 5]);
const config: ProductMediaPreviewTokenConfig = {
  signingKey: "preview-signing-key-for-tests-only-32",
  maximumLifetimeSeconds: 300
};
const asset: ProductMediaAsset = {
  id: "11111111-1111-4111-8111-111111111111",
  productId: "22222222-2222-4222-8222-222222222222",
  kind: "image", bucket: "local-volume", storageBackend: "local_volume",
  objectKey: "12345678-1234-4234-8234-123456789abc.jpg",
  mimeType: "image/jpeg", byteSize: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  sourceUrl: "https://media.example/image.jpg", sourcePublisher: "Example",
  rightsStatus: "unverified", rightsBasis: null, rightsEvidenceUrl: null, rightsVerifiedAt: null,
  createdAt: new Date(now).toISOString()
};
const token = (row: ProductMediaAsset = asset) => createProductMediaPreviewToken({
  assetId: row.id, productId: row.productId, sha256: row.sha256!,
  expiresAt: Math.floor(now / 1000) + 120
}, config, now);
const repository = (row?: ProductMediaAsset) => ({
  findById: async (id: string) => row?.id === id ? row : undefined
}) as ProductMediaAssetRepository;

test("authorizes a short-lived preview for local media while rights remain unverified", async () => {
  const result = await authorizeProductMediaPreview({
    token: token(), tokenConfig: config, assets: repository(asset),
    readLocal: async () => bytes, maximumBytes: 1024, now
  });
  assert.equal(result.asset.id, asset.id);
  assert.deepEqual(result.bytes, bytes);
});

test("rejects preview when asset content changes after token creation", async () => {
  const changed = { ...asset, sha256: "b".repeat(64) };
  await assert.rejects(() => authorizeProductMediaPreview({
    token: token(), tokenConfig: config, assets: repository(changed),
    readLocal: async () => bytes, maximumBytes: 1024, now
  }), /unavailable/);
});

test("rejects non-local storage assets", async () => {
  const supabaseAsset = { ...asset, storageBackend: "supabase" as const };
  await assert.rejects(() => authorizeProductMediaPreview({
    token: token(supabaseAsset), tokenConfig: config, assets: repository(supabaseAsset),
    readLocal: async () => bytes, maximumBytes: 1024, now
  }), /unavailable/);
});

test("rejects modified local bytes", async () => {
  await assert.rejects(() => authorizeProductMediaPreview({
    token: token(), tokenConfig: config, assets: repository(asset),
    readLocal: async () => new Uint8Array([9, 9, 9]), maximumBytes: 1024, now
  }), /integrity/);
});
