import test from "node:test";
import assert from "node:assert/strict";
import { ProductIllustrativeImageGenerationError, ProductIllustrativeImageGenerationService } from "../../src/domain/product-illustrative-image-generation.js";
import type { ProductMediaAsset } from "../../src/domain/product-media-ingestion.js";

const productId = "11111111-1111-4111-8111-111111111111";
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XioAAAAASUVORK5CYII=", "base64"));

const makeHarness = (product: any = { id: productId, name: "Example product", category: "Home and kitchen", status: "active" }) => {
  const saved: ProductMediaAsset[] = [];
  let providerCalls = 0;
  let uploadCalls = 0;
  let removed: string[] = [];
  const assets = {
    async findByProductAndSourceUrl(_id: string, sourceUrl: string) { return saved.find((asset) => asset.sourceUrl === sourceUrl); },
    async findByProductAndHash(_id: string, sha256: string) { return saved.find((asset) => asset.sha256 === sha256); },
    async save(asset: ProductMediaAsset) { saved.push(asset); return asset; }
  };
  const storage = {
    bucketName: "local-volume",
    async upload(input: any) { uploadCalls++; assert.equal(input.contentType, "image/png"); return { backend: "local_volume", bucket: "local-volume", key: input.key }; },
    async remove(key: string) { removed.push(key); }
  };
  const service = new ProductIllustrativeImageGenerationService(
    { async findById() { return product; } },
    assets as never,
    storage as never,
    {
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        providerCalls++;
        assert.equal(url, "https://api.openai.com/v1/images/generations");
        assert.equal(init?.method, "POST");
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "gpt-image-2");
        assert.equal(body.n, 1);
        assert.equal(body.quality, "medium");
        assert.equal(body.output_format, "png");
        assert.match(body.prompt, /Do not depict, render, imitate/);
        assert.match(body.prompt, /home and kitchen/);
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(png).toString("base64") }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    }
  );
  return { service, saved, get providerCalls() { return providerCalls; }, get uploadCalls() { return uploadCalls; }, removed };
};

test("creates a category-inspired AI artwork without depicting the actual product and keeps rights unverified", async () => {
  const harness = makeHarness();
  const result = await harness.service.generate(productId);
  assert.equal(result.generated, true);
  assert.equal(result.asset.kind, "image");
  assert.equal(result.asset.mimeType, "image/png");
  assert.equal(result.asset.rightsStatus, "unverified");
  assert.equal(result.asset.rightsBasis, null);
  assert.equal(result.asset.identityStatus, "not_required");
  assert.equal(result.asset.identityReviewReason, null);
  assert.equal(result.asset.storageBackend, "local_volume");
  assert.equal(result.asset.bucket, "local-volume");
  assert.equal(result.asset.sourceProvider, "openai");
  assert.equal(result.asset.sourceUrl, "generated:openai-abstract-illustration:v1:home%20and%20kitchen");
  assert.match(result.asset.sourceTitle ?? "", /not a depiction of the physical product/i);
  assert.equal(harness.providerCalls, 1);
  assert.equal(harness.uploadCalls, 1);
});

test("reuses an existing abstract illustration without another paid provider call", async () => {
  const harness = makeHarness();
  const first = await harness.service.generate(productId);
  const second = await harness.service.generate(productId);
  assert.equal(first.generated, true);
  assert.equal(second.generated, false);
  assert.equal(second.asset.id, first.asset.id);
  assert.equal(harness.providerCalls, 1);
  assert.equal(harness.uploadCalls, 1);
});

test("rejects inactive products before calling the image provider", async () => {
  const harness = makeHarness({ id: productId, name: "Example", category: "Home", status: "inactive" });
  await assert.rejects(
    () => harness.service.generate(productId),
    (error: unknown) => error instanceof ProductIllustrativeImageGenerationError && error.code === "PRODUCT_NOT_ACTIVE"
  );
  assert.equal(harness.providerCalls, 0);
  assert.equal(harness.uploadCalls, 0);
});

test("does not persist an invalid provider image", async () => {
  const harness = makeHarness();
  const badService = new ProductIllustrativeImageGenerationService(
    { async findById() { return { id: productId, name: "Example", category: "Home", status: "active" }; } },
    {
      async findByProductAndSourceUrl() { return undefined; },
      async findByProductAndHash() { return undefined; },
      async save() { throw new Error("must not save"); }
    } as never,
    {
      bucketName: "affiliate-media",
      async upload() { throw new Error("must not upload"); },
      async remove() {}
    } as never,
    { apiKey: "test-key", fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }), { status: 200 }) }
  );
  await assert.rejects(
    () => badService.generate(productId),
    (error: unknown) => error instanceof ProductIllustrativeImageGenerationError && error.code === "GENERATED_IMAGE_INVALID"
  );
});
