import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";

test("content Story HTTP endpoints read an empty Story and accept an empty product selection", async () => {
  const app = createApp();

  try {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/content",
      payload: {
        platform: "instagram",
        contentType: "story",
        title: "Multi-product Story",
      },
    });

    assert.equal(createResponse.statusCode, 201);
    const content = createResponse.json();

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/v1/content/${content.id}/story`,
    });

    assert.equal(getResponse.statusCode, 200);
    assert.deepEqual(getResponse.json().products, []);

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/v1/content/${content.id}/story/products`,
      payload: { products: [] },
    });

    assert.equal(putResponse.statusCode, 200);
    assert.deepEqual(putResponse.json().products, []);
  } finally {
    await app.close();
  }
});

test("content Story HTTP endpoints reject malformed product selections", async () => {
  const app = createApp();

  try {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/content",
      payload: {
        platform: "instagram",
        contentType: "story",
        title: "Validation Story",
      },
    });

    assert.equal(createResponse.statusCode, 201);
    const content = createResponse.json();

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/content/${content.id}/story/products`,
      payload: {
        products: [{
          productId: "not-a-uuid",
          position: -1,
          role: "unknown",
        }],
      },
    });

    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("content Story HTTP endpoints return not found for an unknown content id", async () => {
  const app = createApp();

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/content/00000000-0000-4000-8000-000000000099/story",
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, "CONTENT_NOT_FOUND");
  } finally {
    await app.close();
  }
});
