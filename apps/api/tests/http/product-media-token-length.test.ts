import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";
import { createInMemoryServices } from "../../src/domain/container.js";
import type { ProductMediaAsset } from "../../src/domain/product-media-ingestion.js";

test("Fastify accepts bounded signed media tokens for preview and delivery routes", async () => {
  const services = createInMemoryServices();
  const token = "x".repeat(415);
  const received: string[] = [];
  const bytes = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 112, 52, 0, 0]);
  const asset = {
    id: "11111111-1111-4111-8111-111111111111",
    productId: "22222222-2222-4222-8222-222222222222",
    kind: "video",
    bucket: "local-volume",
    storageBackend: "local_volume",
    objectKey: "11111111-1111-4111-8111-111111111111.mp4",
    mimeType: "video/mp4",
    byteSize: bytes.byteLength,
    sha256: "a".repeat(64),
    sourceUrl: "generated:test",
    rightsStatus: "unverified",
    createdAt: new Date().toISOString()
  } as unknown as ProductMediaAsset;
  const deliver = async (receivedToken: string) => {
    received.push(receivedToken);
    return { asset, bytes };
  };
  services.productMediaPreviewDelivery = deliver;
  services.productMediaDelivery = deliver;

  const app = createApp(services, {
    auth: { enabled: false, operatorId: "media-token-test", role: "admin" },
    rateLimit: { enabled: false, limit: 100, windowMs: 60_000 }
  });

  try {
    for (const route of ["preview", "delivery"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/product-media/${route}/${token}`
      });
      assert.equal(response.statusCode, 200, `${route} route should accept a 415-character signed token`);
      assert.equal(response.headers["content-type"], "video/mp4");
      assert.deepEqual(new Uint8Array(response.rawPayload), bytes);
    }
    assert.deepEqual(received, [token, token]);
  } finally {
    await app.close();
  }
});
