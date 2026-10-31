import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import type { Product } from "@affiliateos/shared";
import { ProductPromoVideoRenderer } from "../../src/domain/product-promo-video-renderer.js";
import type { ProductMediaAsset } from "../../src/domain/product-media-ingestion.js";

const product: Pick<Product, "id" | "name"> = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Produk Contoh AffiliateOS"
};
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l0sAAAAASUVORK5CYII=", "base64");
const mp4Bytes = new Uint8Array([
  0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 112, 52, 0, 0,
  0, 0, 0, 9, 109, 100, 97, 116, 1
]);

const imageAsset: ProductMediaAsset = {
  id: "22222222-2222-4222-8222-222222222222",
  productId: product.id,
  kind: "image",
  bucket: "affiliate-media",
  objectKey: `products/${product.id}/source.png`,
  mimeType: "image/png",
  byteSize: imageBytes.byteLength,
  sha256: "a".repeat(64),
  sourceUrl: "https://cdn.example.test/product.png",
  createdAt: "2026-10-31T00:00:00.000Z"
};

test("renders and persists a generated 9:16 MP4 from a validated stored product image", async () => {
  const assets: ProductMediaAsset[] = [imageAsset];
  const uploaded: string[] = [];
  const storage = {
    bucketName: "affiliate-media",
    async download(key: string, maxBytes: number) {
      assert.equal(key, imageAsset.objectKey);
      assert.ok(imageBytes.byteLength <= maxBytes);
      return imageBytes;
    },
    async upload(input: { key: string }) {
      uploaded.push(input.key);
      return { bucket: "affiliate-media", key: input.key };
    },
    async remove() {}
  };
  const repository = {
    async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
    async findByProductAndHash(id: string, hash: string) {
      return assets.find((asset) => asset.productId === id && asset.sha256 === hash);
    },
    async save(asset: ProductMediaAsset) { assets.push(asset); return asset; }
  };
  const renderer = new ProductPromoVideoRenderer(storage as never, repository, {
    timeoutMs: 15_000,
    runProcess: async (_binary, args, timeoutMs) => {
      assert.equal(timeoutMs, 15_000);
      assert.ok(args.includes("libx264"));
      assert.ok(args.some((arg) => arg.includes("zoompan")));
      await writeFile(args[args.length - 1]!, mp4Bytes);
    }
  });

  const result = await renderer.render(product);
  assert.equal(result.generated, true);
  assert.equal(result.asset?.kind, "video");
  assert.equal(result.asset?.mimeType, "video/mp4");
  assert.equal(result.asset?.sourceUrl, "generated:ffmpeg");
  assert.equal(assets.length, 2);
  assert.equal(uploaded.length, 1);
});

test("does not render or download when no validated product image exists", async () => {
  let downloads = 0;
  let renders = 0;
  const storage = {
    bucketName: "affiliate-media",
    async download() { downloads++; return imageBytes; },
    async upload() { throw new Error("must not upload"); },
    async remove() {}
  };
  const repository = {
    async listByProduct() { return []; },
    async findByProductAndHash() { return undefined; },
    async save(asset: ProductMediaAsset) { return asset; }
  };
  const renderer = new ProductPromoVideoRenderer(storage as never, repository, {
    runProcess: async () => { renders++; }
  });
  const result = await renderer.render(product);
  assert.equal(result.generated, false);
  assert.match(result.reason ?? "", /No validated product image/);
  assert.equal(downloads, 0);
  assert.equal(renders, 0);
});

test("does not create duplicate video when one already exists", async () => {
  const existingVideo: ProductMediaAsset = {
    ...imageAsset,
    id: "33333333-3333-4333-8333-333333333333",
    kind: "video",
    mimeType: "video/mp4",
    objectKey: `products/${product.id}/existing.mp4`
  };
  let renders = 0;
  const storage = {
    bucketName: "affiliate-media",
    async download() { throw new Error("must not download"); },
    async upload() { throw new Error("must not upload"); },
    async remove() {}
  };
  const repository = {
    async listByProduct() { return [existingVideo]; },
    async findByProductAndHash() { return existingVideo; },
    async save(asset: ProductMediaAsset) { return asset; }
  };
  const renderer = new ProductPromoVideoRenderer(storage as never, repository, {
    runProcess: async () => { renders++; }
  });
  const result = await renderer.render(product);
  assert.equal(result.generated, false);
  assert.equal(result.asset?.id, existingVideo.id);
  assert.equal(renders, 0);
});
