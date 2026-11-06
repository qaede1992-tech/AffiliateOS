import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";
import { createInMemoryServices } from "../../src/domain/container.js";
import { ProductMediaUploadError } from "../../src/domain/product-media-upload-service.js";

const productId = "33333333-3333-4333-8333-333333333333";
const asset = {
  id: "44444444-4444-4444-8444-444444444444",
  productId,
  kind: "image" as const,
  bucket: "affiliate-media",
  objectKey: `products/${productId}/image.png`,
  mimeType: "image/png" as const,
  byteSize: 68,
  width: 1,
  height: 1,
  durationMs: null,
  hasAudio: null,
  sha256: "a".repeat(64),
  sourceUrl: "user-upload://44444444-4444-4444-8444-444444444444",
  sourcePublisher: "user-provided",
  sourceProvider: "user_upload",
  rightsStatus: "unverified" as const,
  rightsBasis: null,
  rightsEvidenceUrl: null,
  rightsVerifiedAt: null,
  createdAt: "2026-11-06T00:00:00.000Z"
};

function makeApp(role: "admin" | "operator" | "viewer", upload?: (input: unknown) => Promise<unknown>) {
  const services = createInMemoryServices();
  services.productMediaUpload = {
    async uploadStream(input: unknown) {
      if (upload) return upload(input);
      return asset;
    }
  } as never;
  const app = createApp(services, {
    auth: { enabled: false, operatorId: "media-uploader-test", role },
    rateLimit: { enabled: false, limit: 100, windowMs: 60_000 }
  });
  return app;
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvWQAAAAASUVORK5CYII=", "base64");

test("admin can upload product-scoped media and rights remain unverified", async () => {
  let received: Record<string, unknown> | undefined;
  const app = makeApp("admin", async (input) => { received = input as Record<string, unknown>; return asset; });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/media-upload?kind=image`,
      headers: { "content-type": "application/octet-stream", "content-length": String(png.byteLength), "x-media-mime-type": "image/png" },
      payload: png
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().productId, productId);
    assert.equal(response.json().rightsStatus, "unverified");
    assert.equal(received?.productId, productId);
    assert.equal(received?.kind, "image");
    assert.equal(received?.mimeType, "image/png");
    assert.equal(received?.contentLength, png.byteLength);
    assert.equal(received?.body instanceof ReadableStream, true);
  } finally {
    await app.close();
  }
});

test("operator can upload product media but viewer is denied before service invocation", async () => {
  const operator = makeApp("operator");
  try {
    const response = await operator.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/media-upload?kind=image`,
      headers: { "content-type": "application/octet-stream", "content-length": String(png.byteLength), "x-media-mime-type": "image/png" },
      payload: png
    });
    assert.equal(response.statusCode, 201);
  } finally {
    await operator.close();
  }

  let calls = 0;
  const viewer = makeApp("viewer", async () => { calls += 1; return asset; });
  try {
    const response = await viewer.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/media-upload?kind=image`,
      headers: { "content-type": "application/octet-stream", "content-length": String(png.byteLength), "x-media-mime-type": "image/png" },
      payload: png
    });
    assert.equal(response.statusCode, 403);
    assert.equal(calls, 0);
  } finally {
    await viewer.close();
  }
});

test("product upload rejects invalid media kind and missing content length before service invocation", async () => {
  let calls = 0;
  const app = makeApp("admin", async () => { calls += 1; return asset; });
  try {
    const invalidKind = await app.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/media-upload?kind=thumbnail`,
      headers: { "content-type": "application/octet-stream", "content-length": String(png.byteLength), "x-media-mime-type": "image/png" },
      payload: png
    });
    assert.equal(invalidKind.statusCode, 400);
    assert.equal(invalidKind.json().error, "INVALID_MEDIA_KIND");

    const missingMime = await app.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/media-upload?kind=image`,
      headers: { "content-type": "application/octet-stream" },
      payload: png
    });
    assert.equal(missingMime.statusCode, 400);
    assert.equal(missingMime.json().error, "MEDIA_MIME_TYPE_REQUIRED");
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test("product upload maps a missing product to 404 without leaking internal details", async () => {
  const app = makeApp("admin", async () => {
    throw new ProductMediaUploadError("Product does not exist.", "PRODUCT_NOT_FOUND");
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/media-upload?kind=image`,
      headers: { "content-type": "application/octet-stream", "content-length": String(png.byteLength), "x-media-mime-type": "image/png" },
      payload: png
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, "PRODUCT_NOT_FOUND");
    assert.equal(response.json().message, "The target product does not exist.");
  } finally {
    await app.close();
  }
});
