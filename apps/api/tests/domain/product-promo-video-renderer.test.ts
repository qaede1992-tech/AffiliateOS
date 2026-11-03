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
  sourcePublisher: "Product owner",
  rightsStatus: "verified",
  rightsBasis: "user_owned",
  rightsEvidenceUrl: "https://publisher.example.test/rights",
  rightsVerifiedAt: "2026-11-02T00:00:00.000Z",
  createdAt: "2026-10-31T00:00:00.000Z"
};

test("passes the configured timeout while rendering and persisting a generated 9:16 MP4", async () => {
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
  assert.equal(result.asset?.rightsStatus, "unverified");
  assert.equal(result.asset?.rightsBasis, null);
  assert.equal(result.asset?.rightsEvidenceUrl, null);
  assert.equal(result.asset?.sourcePublisher, "AffiliateOS");
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
  assert.match(result.reason ?? "", /No verified private product image with a derivative-permitting rights basis/);
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

test("concurrent identical renders cannot delete the video object saved by the winning render", async () => {
  const assets: ProductMediaAsset[] = [imageAsset];
  const uploaded: string[] = [];
  const removed: string[] = [];
  let findCount = 0;
  let releaseFinds!: () => void;
  const bothFinds = new Promise<void>((resolve) => { releaseFinds = resolve; });
  const storage = {
    bucketName: "affiliate-media",
    async download() { return imageBytes; },
    async upload(input: { key: string }) {
      uploaded.push(input.key);
      return { bucket: "affiliate-media", key: input.key };
    },
    async remove(key: string) { removed.push(key); }
  };
  const repository = {
    async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
    async findByProductAndHash() {
      findCount += 1;
      if (findCount === 2) releaseFinds();
      await bothFinds;
      return undefined;
    },
    async save(asset: ProductMediaAsset) {
      if (assets.some((existing) => existing.productId === asset.productId && existing.sha256 === asset.sha256)) {
        throw new Error("duplicate product media hash");
      }
      assets.push(asset);
      return asset;
    }
  };
  const makeRenderer = () => new ProductPromoVideoRenderer(storage as never, repository, {
    runProcess: async (_binary, args) => { await writeFile(args[args.length - 1]!, mp4Bytes); }
  });

  const results = await Promise.all([
    makeRenderer().render(product),
    makeRenderer().render(product)
  ]);
  assert.equal(results.filter((result) => result.generated).length, 1);
  assert.equal(uploaded.length, 2);
  assert.notEqual(uploaded[0], uploaded[1]);
  assert.equal(removed.length, 1);
  assert.notEqual(removed[0], assets.find((asset) => asset.kind === "video")?.objectKey);
  assert.equal(assets.filter((asset) => asset.kind === "video").length, 1);
});


test("rejects an invalid FFmpeg timeout before starting a render", () => {
  const storage = {
    bucketName: "affiliate-media",
    async download() { return imageBytes; },
    async upload() { throw new Error("must not upload"); },
    async remove() {}
  };
  const repository = {
    async listByProduct() { return [imageAsset]; },
    async findByProductAndHash() { return undefined; },
    async save(asset: ProductMediaAsset) { return asset; }
  };

  assert.throws(
    () => new ProductPromoVideoRenderer(storage as never, repository, { timeoutMs: 0 }),
    /positive safe integer/
  );
  assert.throws(
    () => new ProductPromoVideoRenderer(storage as never, repository, { timeoutMs: 1.5 }),
    /positive safe integer/
  );
});


test("removes only a duplicate losing upload when the repository returns the concurrent winner", async () => {
  const winner: ProductMediaAsset = {
    ...imageAsset,
    id: "44444444-4444-4444-8444-444444444444",
    kind: "video",
    mimeType: "video/mp4",
    objectKey: `products/${product.id}/winner.mp4`
  };
  const removed: string[] = [];
  const storage = {
    bucketName: "affiliate-media",
    async download() { return imageBytes; },
    async upload(input: { key: string }) { return { bucket: "affiliate-media", key: input.key }; },
    async remove(key: string) { removed.push(key); }
  };
  const repository = {
    async listByProduct() { return [imageAsset]; },
    async findByProductAndHash() { return undefined; },
    async save() { return winner; }
  };
  const renderer = new ProductPromoVideoRenderer(storage as never, repository, {
    runProcess: async (_binary, args) => { await writeFile(args[args.length - 1]!, mp4Bytes); }
  });
  const result = await renderer.render(product);
  assert.equal(result.generated, false);
  assert.equal(result.asset?.objectKey, winner.objectKey);
  assert.equal(removed.length, 1);
  assert.notEqual(removed[0], winner.objectKey);
});


test("does not create derivatives from unverified source images", async () => {
  const unverified = { ...imageAsset, rightsStatus: "unverified" as const, rightsBasis: null, rightsEvidenceUrl: null, rightsVerifiedAt: null };
  let downloads = 0;
  let renders = 0;
  const storage = {
    bucketName: "affiliate-media",
    async download() { downloads++; return imageBytes; },
    async upload() { throw new Error("must not upload"); },
    async remove() {}
  };
  const repository = {
    async listByProduct() { return [unverified]; },
    async findByProductAndHash() { return undefined; },
    async save(asset: ProductMediaAsset) { return asset; }
  };
  const renderer = new ProductPromoVideoRenderer(storage as never, repository, {
    runProcess: async () => { renders++; }
  });
  const result = await renderer.render(product);
  assert.equal(result.generated, false);
  assert.match(result.reason ?? "", /No verified private product image with a derivative-permitting rights basis/);
  assert.equal(downloads, 0);
  assert.equal(renders, 0);
});

test("does not assume a generic license permits derivative video creation", async () => {
  const licensed = { ...imageAsset, rightsBasis: "license" as const };
  let downloads = 0;
  const storage = {
    bucketName: "affiliate-media",
    async download() { downloads++; return imageBytes; },
    async upload() { throw new Error("must not upload"); },
    async remove() {}
  };
  const repository = {
    async listByProduct() { return [licensed]; },
    async findByProductAndHash() { return undefined; },
    async save(asset: ProductMediaAsset) { return asset; }
  };
  const renderer = new ProductPromoVideoRenderer(storage as never, repository, {});
  const result = await renderer.render(product);
  assert.equal(result.generated, false);
  assert.match(result.reason ?? "", /verified rights that permit derivative creation/);
  assert.equal(downloads, 0);
});


test("ignores an existing video outside the configured private bucket and renders a private copy", async () => {
  const externalVideo: ProductMediaAsset = {
    ...imageAsset,
    id: "55555555-5555-4555-8555-555555555555",
    kind: "video",
    bucket: "legacy-public",
    mimeType: "video/mp4",
    objectKey: `products/${product.id}/legacy.mp4`
  };
  const assets: ProductMediaAsset[] = [imageAsset, externalVideo];
  const uploaded: string[] = [];
  const removed: string[] = [];
  const storage = {
    bucketName: "affiliate-media",
    async download() { return imageBytes; },
    async upload(input: { key: string }) {
      uploaded.push(input.key);
      return { bucket: "affiliate-media", key: input.key };
    },
    async remove(key: string) { removed.push(key); }
  };
  const repository = {
    async listByProduct(id: string) { return assets.filter((asset) => asset.productId === id); },
    async findByProductAndHash() { return undefined; },
    async save(asset: ProductMediaAsset) { assets.push(asset); return asset; }
  };
  const renderer = new ProductPromoVideoRenderer(storage as never, repository, {
    runProcess: async (_binary, args) => { await writeFile(args[args.length - 1]!, mp4Bytes); }
  });

  const result = await renderer.render(product);
  assert.equal(result.generated, true);
  assert.equal(result.asset?.bucket, "affiliate-media");
  assert.equal(result.asset?.kind, "video");
  assert.equal(uploaded.length, 1);
  assert.equal(removed.length, 0);
  assert.equal(assets.filter((asset) => asset.kind === "video").length, 2);
});
