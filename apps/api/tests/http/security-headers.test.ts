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
  assert.equal(response.headers["cache-control"], undefined);
  assert.equal(response.headers["strict-transport-security"], undefined);

  const authResponse = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { authorization: "Bearer test-api-token" }
  });

  assert.equal(authResponse.statusCode, 200);
  assert.equal(authResponse.headers["cache-control"], "no-store");

  await app.close();
});

test("production API responses enable HSTS", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCorsOrigin = process.env.API_CORS_ORIGIN;
  process.env.NODE_ENV = "production";
  process.env.API_CORS_ORIGIN = "https://app.example.com";

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
    if (previousCorsOrigin === undefined) delete process.env.API_CORS_ORIGIN;
    else process.env.API_CORS_ORIGIN = previousCorsOrigin;
  }
});
