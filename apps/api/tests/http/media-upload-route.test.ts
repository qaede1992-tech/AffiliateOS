import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";
import type { Services } from "../../src/domain/container.js";

const token = "test-media-upload-token";
const contentId = "123e4567-e89b-42d3-a456-426614174000";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function makeApp(role: "admin" | "operator" | "viewer" = "operator") {
  let uploadedBytes = 0;
  let uploadCalls = 0;
  const services = {
    mediaUpload: {
      async uploadStream(input: { contentId: string; kind: string; mimeType: string; body: ReadableStream<Uint8Array>; contentLength: number }) {
        uploadCalls += 1;
        assert.equal(input.contentId, contentId);
        assert.equal(input.kind, "image");
        assert.equal(input.mimeType, "image/png");
        const reader = input.body.getReader();
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            uploadedBytes += item.value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }
        assert.equal(uploadedBytes, input.contentLength);
        return { id: "media-asset-test", contentId: input.contentId, kind: input.kind, mimeType: input.mimeType, byteSize: uploadedBytes };
      }
    }
  } as unknown as Services;
  const app = createApp(services, {
    auth: { enabled: true, token, operatorId: "test-operator", role },
    rateLimit: { enabled: false, limit: 100, windowMs: 60_000 }
  });
  return { app, get uploadedBytes() { return uploadedBytes; }, get uploadCalls() { return uploadCalls; } };
}

test("media upload HTTP route requires authentication", async () => {
  const fixture = makeApp();
  try {
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/content/media-upload?contentId=${contentId}&kind=image`,
      headers: { "content-type": "application/octet-stream", "x-media-mime-type": "image/png" },
      payload: png
    });
    assert.equal(response.statusCode, 401);
    assert.equal(fixture.uploadCalls, 0);
  } finally {
    await fixture.app.close();
  }
});

test("media upload HTTP route rejects viewer role", async () => {
  const fixture = makeApp("viewer");
  try {
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/content/media-upload?contentId=${contentId}&kind=image`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-media-mime-type": "image/png" },
      payload: png
    });
    assert.equal(response.statusCode, 403);
    assert.equal(fixture.uploadCalls, 0);
  } finally {
    await fixture.app.close();
  }
});

test("media upload HTTP route streams octet-stream body for an authorized operator", async () => {
  const fixture = makeApp();
  try {
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/content/media-upload?contentId=${contentId}&kind=image`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-media-mime-type": "image/png" },
      payload: png
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().byteSize, png.byteLength);
    assert.equal(fixture.uploadCalls, 1);
    assert.equal(fixture.uploadedBytes, png.byteLength);
  } finally {
    await fixture.app.close();
  }
});

test("media upload HTTP route rejects a non-octet-stream request", async () => {
  const fixture = makeApp();
  try {
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/content/media-upload?contentId=${contentId}&kind=image`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-media-mime-type": "image/png" },
      payload: { fake: "body" }
    });
    assert.equal(response.statusCode, 415);
    assert.equal(fixture.uploadCalls, 0);
  } finally {
    await fixture.app.close();
  }
});
