import assert from "node:assert/strict";
import test from "node:test";
import { ProductMediaDiscoveryRunner } from "../src/domain/product-media-discovery-runner.js";

test("publication readiness snapshot derives all gates from one batch asset read", async () => {
  let batchReads = 0;
  const verifiedVideo = {
    id: "asset-video", productId: "product-1", kind: "video", bucket: "private-media",
    objectKey: "products/product-1/video.mp4", mimeType: "video/mp4", byteSize: 1024,
    sha256: "a".repeat(64), sourceUrl: "https://media.example/video.mp4", sourcePublisher: "Publisher",
    rightsStatus: "verified", rightsBasis: "explicit_permission",
    rightsEvidenceUrl: "https://publisher.example/permission", rightsVerifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  const unverifiedImage = {
    id: "asset-image", productId: "product-2", kind: "image", bucket: "private-media",
    objectKey: "products/product-2/image.jpg", mimeType: "image/jpeg", byteSize: 512,
    sha256: "b".repeat(64), sourceUrl: "https://media.example/image.jpg", sourcePublisher: "Publisher",
    rightsStatus: "unverified", rightsBasis: null, rightsEvidenceUrl: null, rightsVerifiedAt: null,
    createdAt: new Date().toISOString()
  };
  const assets = {
    async listByProducts(ids: string[]) {
      batchReads += 1;
      assert.deepEqual(ids, ["product-1", "product-2"]);
      return [verifiedVideo, unverifiedImage] as never;
    },
    async listByProduct() { throw new Error("per-product fallback should not run"); }
  };
  const runner = new ProductMediaDiscoveryRunner(
    { bucketName: "private-media" } as never,
    assets as never,
    {} as never
  );

  const snapshot = await runner.getPublicationReadinessSnapshot(
    ["product-1", "product-2", "product-1"],
    ["instagram"]
  );

  assert.equal(batchReads, 1);
  assert.deepEqual(snapshot.publishableMediaProductIds, ["product-1"]);
  assert.deepEqual(snapshot.publishableVideoProductIds, ["product-1"]);
  assert.deepEqual(snapshot.storedVideoProductIds, ["product-1"]);
  assert.ok(snapshot.mediaReadinessScores["product-1"] > 0);
  assert.equal(snapshot.mediaReadinessScores["product-2"], 0);
});
