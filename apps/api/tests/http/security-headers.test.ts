import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";

const auth = {
  enabled: true,
  token: "test-api-token",
  operatorId: "operator-test",
  role: "operator" as const
};

test("API responses include baseline browser security headers", async () => {
  const app = createApp(undefined, { auth });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
  assert.equal(response.headers["strict-transport-security"], undefined);

  await app.close();
});

test("production API responses enable HSTS", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const app = createApp(undefined, { auth });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health"
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.headers["strict-transport-security"],
      "max-age=31536000; includeSubDomains"
    );

    await app.close();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
