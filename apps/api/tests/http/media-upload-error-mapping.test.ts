import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";

test("unsupported media upload content type returns a safe 415 error response", async () => {
  const app = createApp(undefined, {
    auth: {
      enabled: true,
      token: "media-upload-test-token-1234567890",
      operatorId: "media-upload-test-operator",
      role: "admin"
    },
    rateLimit: { enabled: false, limit: 100, windowMs: 60_000 }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/content/media-upload?contentId=123e4567-e89b-42d3-a456-426614174099&kind=image",
      headers: {
        authorization: "Bearer media-upload-test-token-1234567890",
        "content-type": "image/png",
        "x-media-mime-type": "image/png"
      },
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    });

    assert.equal(response.statusCode, 415);
    assert.deepEqual(response.json(), {
      error: "UNSUPPORTED_MEDIA_TYPE",
      message: "The request content type is not supported."
    });
  } finally {
    await app.close();
  }
});
