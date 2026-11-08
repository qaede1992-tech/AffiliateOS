import test from "node:test";
import assert from "node:assert/strict";
import { ProductImageGenerationError, ProductImageGenerationService } from "../src/domain/product-image-generation.js";
import type { ProductMediaAsset, ProductMediaAssetRepository } from "../src/domain/product-media-ingestion.js";

const productId = "11111111-1111-4111-8111-111111111111";
const referenceId = "22222222-2222-4222-8222-222222222222";
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XioAAAAASUVORK5CYII=", "base64"));

const makeReference = (overrides: Partial<ProductMediaAsset> = {}): ProductMediaAsset => ({
  id: referenceId,
  productId,
  kind: "image",
  bucket: "affiliate-media",
  objectKey: `products/${productId}/reference.png`,
  mimeType: "image/png",
  byteSize: png.byteLength,
  width: 1,
  height: 1,
  durationMs: null,
  hasAudio: null,
  sha256: "a".repeat(64),
  sourceUrl: "user-upload://reference",
  sourcePublisher: "user",
  sourceProvider: "user_upload",
  rightsStatus: "verified",
  rightsBasis: "user_owned",
  rightsEvidenceUrl: "https://evidence.example/ownership",
  rightsVerifiedAt: new Date(Date.now() - 1000).toISOString(),
  createdAt: new Date().toISOString(),
  ...overrides
});

const makeHarness = (reference = makeReference()) => {
  const saved: ProductMediaAsset[] = [];
  let providerCalls = 0;
  const assets: ProductMediaAssetRepository = {
    async findByProductAndHash(_id, hash) { return saved.find((asset) => asset.sha256 === hash); },
    async listByProduct() { return [reference, ...saved]; },
    async save(asset) { saved.push(asset); return asset; }
  };
  const storage = {
    bucketName: "affiliate-media",
    async download() { return png; },
    async upload(input: { key: string; bytes: Uint8Array; contentType: string }) {
      assert.equal(input.contentType, "image/png");
      return { bucket: "affiliate-media", key: input.key };
    },
    async remove() {}
  };
  const service = new ProductImageGenerationService(
    { async findById() { return { id: productId }; } },
    assets,
    storage,
    {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        providerCalls++;
        assert.equal(url, "https://api.openai.com/v1/images/edits");
        assert.equal(init?.method, "POST");
        const form = init?.body as FormData;
        assert.equal(form.get("model"), "gpt-image-2.5-sunburst");
        assert.match(String(form.get("prompt")), /PRODUCT IDENTITY IS THE HIGHEST PRIORITY/);
        assert.equal(form.get("n"), "1");
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(png).toString("base64") }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    }
  );
  return { service, saved, get providerCalls() { return providerCalls; } };
};

test("AI product image editing requires a verified user-owned private reference", async () => {
  const harness = makeHarness(makeReference({ rightsStatus: "unverified", rightsBasis: null, rightsEvidenceUrl: null, rightsVerifiedAt: null }));
  await assert.rejects(
    () => harness.service.generate({ productId, referenceAssetId: referenceId, style: "studio" }),
    (error: unknown) => error instanceof ProductImageGenerationError && error.code === "REFERENCE_NOT_ELIGIBLE"
  );
  assert.equal(harness.providerCalls, 0);
  assert.equal(harness.saved.length, 0);
});

test("AI product image editing stores output as unverified and records reference provenance", async () => {
  const harness = makeHarness();
  const result = await harness.service.generate({ productId, referenceAssetId: referenceId, style: "lifestyle" });
  assert.equal(result.generated, true);
  assert.equal(result.asset?.kind, "image");
  assert.equal(result.asset?.mimeType, "image/png");
  assert.equal(result.asset?.rightsStatus, "unverified");
  assert.equal(result.asset?.rightsBasis, null);
  assert.equal(result.asset?.sourceProvider, "openai");
  assert.equal(result.asset?.sourceUrl, `generated:openai-image-edit:${referenceId}`);
  assert.match(result.asset?.sourceTitle ?? "", new RegExp(referenceId));
  assert.equal(harness.providerCalls, 1);
  assert.equal(harness.saved.length, 1);
});

test("AI product image editing rejects a reference asset from another product", async () => {
  const harness = makeHarness(makeReference({ productId: "33333333-3333-4333-8333-333333333333" }));
  await assert.rejects(
    () => harness.service.generate({ productId, referenceAssetId: referenceId, style: "minimal" }),
    (error: unknown) => error instanceof ProductImageGenerationError && error.code === "REFERENCE_NOT_FOUND"
  );
  assert.equal(harness.providerCalls, 0);
});
