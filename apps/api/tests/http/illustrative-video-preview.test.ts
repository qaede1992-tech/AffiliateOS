import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";
import { createInMemoryServices } from "../../src/domain/container.js";
import {
  IllustrativeProductVideoPreviewError,
  IllustrativeProductVideoPreviewService
} from "../../src/domain/illustrative-product-video-preview.js";

const productId = "33333333-3333-4333-8333-333333333333";
const result = {
  bytes: new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 112, 52, 0, 0]),
  metadata: {
    mimeType: "video/mp4" as const, width: 720 as const, height: 1280 as const,
    durationMs: 12_000 as const, fps: 25 as const, codec: "h264" as const,
    sha256: "a".repeat(64), byteSize: 16
  }
};

function makeApp(role: "admin" | "operator" | "viewer" = "admin", render?: () => Promise<typeof result>) {
  const services = createInMemoryServices();
  services.illustrativeVideoPreview = {
    render: render ?? (async () => result)
  } as unknown as IllustrativeProductVideoPreviewService;
  return createApp(services, {
    auth: { enabled: false, operatorId: "preview-test", role },
    rateLimit: { enabled: false, limit: 10, windowMs: 60_000 }
  });
}

test("admin receives an ephemeral MP4 preview with explicit non-publication headers", async () => {
  const app = makeApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/illustrative-video-preview`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "video/mp4");
    assert.equal(response.headers["x-affiliateos-preview-only"], "true");
    assert.equal(response.headers["x-affiliateos-rights-status"], "unverified");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.rawPayload.byteLength, result.bytes.byteLength);
    assert.deepEqual(new Uint8Array(response.rawPayload), result.bytes);
  } finally {
    await app.close();
  }
});

test("preview route rejects non-admin callers", async () => {
  const app = makeApp("operator");
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/illustrative-video-preview`
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("preview route maps stale or ineligible products to a conflict without returning media", async () => {
  const app = makeApp("admin", async () => {
    throw new IllustrativeProductVideoPreviewError(
      "PRE_MEDIA_ELIGIBILITY_REQUIRED",
      "Produk belum lolos seleksi non-media AffiliateOS."
    );
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/illustrative-video-preview`
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "PRE_MEDIA_ELIGIBILITY_REQUIRED");
  } finally {
    await app.close();
  }
});

test("public media preview route accepts bounded signed tokens longer than Fastify's default parameter limit", async () => {
  const services = createInMemoryServices();
  let receivedToken = "";
  services.productMediaPreviewDelivery = async (token: string) => {
    receivedToken = token;
    return {
      asset: { mimeType: "video/mp4" } as never,
      bytes: result.bytes
    };
  };
  const app = createApp(services, {
    auth: { enabled: false, operatorId: "preview-test", role: "admin" },
    rateLimit: { enabled: false, limit: 10, windowMs: 60_000 }
  });
  const token = "a".repeat(320);
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/product-media/preview/${token}`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(receivedToken, token);
    assert.equal(response.headers["content-type"], "video/mp4");
    assert.equal(response.headers["cache-control"], "private, no-store, max-age=0");
    assert.deepEqual(new Uint8Array(response.rawPayload), result.bytes);
  } finally {
    await app.close();
  }
});
