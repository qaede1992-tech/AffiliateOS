import assert from "node:assert/strict";
import test from "node:test";
import type { MediaAsset } from "../../src/domain/media-asset.js";
import { resolvePublisherMediaAssets } from "../../src/domain/publisher-media-resolver.js";

const contentId = "11111111-1111-4111-8111-111111111111";
const asset: MediaAsset = {
  id: "22222222-2222-4222-8222-222222222222",
  contentId,
  kind: "image",
  source: "object-storage",
  reference: `affiliate-media/content/${contentId}/image.jpg`,
  mimeType: "image/jpeg",
  byteSize: 123,
  createdAt: "2026-10-27T00:00:00.000Z",
  updatedAt: "2026-10-27T00:00:00.000Z"
};

test("resolves a private object to a short-lived HTTPS URL without mutating persisted metadata", async () => {
  let requestedKey = "";
  let requestedTtl = 0;
  const storage = {
    bucketName: "affiliate-media",
    async createSignedUrl(key: string, ttl: number) {
      requestedKey = key;
      requestedTtl = ttl;
      return "https://project.supabase.co/storage/v1/object/sign/affiliate-media/image.jpg?token=temporary";
    }
  };
  const [resolved] = await resolvePublisherMediaAssets({ id: contentId }, [asset], storage);
  assert.equal(resolved.source, "url");
  assert.equal(resolved.reference.startsWith("https://"), true);
  assert.equal(requestedKey, `content/${contentId}/image.jpg`);
  assert.equal(requestedTtl, 3600);
  assert.equal(asset.source, "object-storage");
  assert.equal(asset.reference, `affiliate-media/content/${contentId}/image.jpg`);
});

test("rejects private media when Storage is not configured", async () => {
  await assert.rejects(
    resolvePublisherMediaAssets({ id: contentId }, [asset]),
    /requires configured Supabase Storage/
  );
});

test("rejects bucket mismatch and cross-content object keys", async () => {
  const storage = {
    bucketName: "affiliate-media",
    async createSignedUrl() { return "https://project.supabase.co/signed"; }
  };
  await assert.rejects(
    resolvePublisherMediaAssets({ id: contentId }, [{ ...asset, reference: "other-bucket/content/" + contentId + "/image.jpg" }], storage),
    /unexpected Storage bucket/
  );
  await assert.rejects(
    resolvePublisherMediaAssets({ id: contentId }, [{ ...asset, reference: "affiliate-media/content/33333333-3333-4333-8333-333333333333/image.jpg" }], storage),
    /outside the publishing content or linked-product scope/
  );
});

test("resolves product-owned video only when that product is linked to the content", async () => {
  const productId = "33333333-3333-4333-8333-333333333333";
  let requestedKey = "";
  const storage = {
    bucketName: "affiliate-media",
    async createSignedUrl(key: string) { requestedKey = key; return "https://project.supabase.co/storage/v1/object/sign/affiliate-media/video.mp4?token=temporary"; }
  };
  const productVideo = { ...asset, kind: "video" as const, mimeType: "video/mp4", reference: `affiliate-media/products/${productId}/abc.mp4` };
  const [resolved] = await resolvePublisherMediaAssets({ id: contentId }, [productVideo], storage, [productId]);
  assert.equal(resolved?.source, "url");
  assert.equal(requestedKey, `products/${productId}/abc.mp4`);
  await assert.rejects(
    resolvePublisherMediaAssets({ id: contentId }, [productVideo], storage, []),
    /outside the publishing content or linked-product scope/
  );
});

test("preserves existing HTTPS URL assets without requesting a signed URL", async () => {
  const publicAsset = { ...asset, source: "url" as const, reference: "https://images.example/image.jpg" };
  const storage = {
    bucketName: "affiliate-media",
    async createSignedUrl() { throw new Error("must not be called"); }
  };
  const [resolved] = await resolvePublisherMediaAssets({ id: contentId }, [publicAsset], storage);
  assert.equal(resolved, publicAsset);
});
