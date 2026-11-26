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
  const publicAsset = { ...asset, source: "url" as const, reference: "https://images.example.com/image.jpg" };
  const storage = {
    bucketName: "affiliate-media",
    async createSignedUrl() { throw new Error("must not be called"); }
  };
  const [resolved] = await resolvePublisherMediaAssets({ id: contentId }, [publicAsset], storage);
  assert.equal(resolved, publicAsset);
});


test("rejects credentialed URL assets before they reach a publisher", async () => {
  const credentialedAsset = { ...asset, source: "url" as const, reference: "https://user:password@images.example.com/image.jpg" };
  await assert.rejects(
    resolvePublisherMediaAssets({ id: contentId }, [credentialedAsset]),
    /credential-free public HTTPS hostname/
  );
});

test("rejects IP-literal and local-only URL assets before they reach a publisher", async () => {
  for (const reference of [
    "https://127.0.0.1/image.jpg",
    "https://[::1]/image.jpg",
    "https://metadata.google.internal/image.jpg"
  ]) {
    await assert.rejects(
      resolvePublisherMediaAssets({ id: contentId }, [{ ...asset, source: "url" as const, reference }]),
      /credential-free public HTTPS hostname/
    );
  }
});

test("rejects a signed URL containing embedded credentials", async () => {
  const storage = {
    bucketName: "affiliate-media",
    async createSignedUrl() { return "https://user:password@project.supabase.co/signed"; }
  };
  await assert.rejects(
    resolvePublisherMediaAssets({ id: contentId }, [asset], storage),
    /credential-free public HTTPS hostname/
  );
});


test("routes an explicitly approved generated MP4 through local delivery and never Supabase", async () => {
  let storageCalls = 0;
  let generatedCalls = 0;
  const storage = {
    bucketName: "affiliate-media",
    async createSignedUrl() { storageCalls += 1; throw new Error("generated media must not use Supabase"); }
  };
  const generated = {
    ...asset,
    kind: "video" as const,
    mimeType: "video/mp4",
    reference: `affiliate-media/content/${contentId}/generated.mp4`
  };
  const [resolved] = await resolvePublisherMediaAssets(
    { id: contentId },
    [generated],
    storage,
    [],
    {
      generatedMediaAssetIds: new Set([generated.id]),
      async resolveGeneratedMediaUrl(received, receivedContentId) {
        generatedCalls += 1;
        assert.equal(received.id, generated.id);
        assert.equal(receivedContentId, contentId);
        return "https://api.example.com/api/v1/public/illustrative-media/33333333-3333-4333-8333-333333333333?token=opaque";
      }
    }
  );
  assert.equal(resolved?.source, "url");
  assert.match(resolved?.reference ?? "", /public\/illustrative-media/);
  assert.equal(storageCalls, 0);
  assert.equal(generatedCalls, 1);
  assert.equal(generated.source, "object-storage");
});

test("fails closed when a generated asset is marked approved but has no local delivery resolver", async () => {
  const generated = {
    ...asset,
    kind: "video" as const,
    mimeType: "video/mp4",
    reference: `affiliate-media/content/${contentId}/generated.mp4`
  };
  let storageCalls = 0;
  const storage = {
    bucketName: "affiliate-media",
    async createSignedUrl() { storageCalls += 1; return "https://project.supabase.co/signed"; }
  };
  await assert.rejects(
    resolvePublisherMediaAssets(
      { id: contentId }, [generated], storage, [],
      { generatedMediaAssetIds: new Set([generated.id]) }
    ),
    /dedicated local-volume delivery resolver/
  );
  assert.equal(storageCalls, 0);
});

test("rejects non-HTTPS or credentialed generated delivery URLs", async () => {
  const generated = {
    ...asset,
    kind: "video" as const,
    mimeType: "video/mp4",
    reference: `affiliate-media/content/${contentId}/generated.mp4`
  };
  for (const reference of ["http://api.example.com/media?token=x", "https://user:pass@api.example.com/media?token=x"]) {
    await assert.rejects(
      resolvePublisherMediaAssets(
        { id: contentId }, [generated], undefined, [],
        {
          generatedMediaAssetIds: new Set([generated.id]),
          async resolveGeneratedMediaUrl() { return reference; }
        }
      ),
      /credential-free public HTTPS hostname/
    );
  }
});

test("keeps ordinary private media on the existing Supabase signed-URL path", async () => {
  let requested = 0;
  const storage = {
    bucketName: "affiliate-media",
    async createSignedUrl(key: string, ttl: number) {
      requested += 1;
      assert.equal(key, `content/${contentId}/image.jpg`);
      assert.equal(ttl, 3600);
      return "https://project.supabase.co/storage/v1/object/sign/affiliate-media/image.jpg?token=ordinary";
    }
  };
  const [resolved] = await resolvePublisherMediaAssets(
    { id: contentId }, [asset], storage, [],
    { generatedMediaAssetIds: new Set() }
  );
  assert.equal(resolved?.source, "url");
  assert.equal(requested, 1);
});
