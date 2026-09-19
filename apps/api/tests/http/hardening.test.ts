import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";

test("health responses include baseline security headers", async () => {
  const app = createApp();
  const response = await app.inject({ method: "GET", url: "/api/v1/health" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.equal(response.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");

  await app.close();
});

test("oversized JSON requests are rejected before reaching resource handlers", async () => {
  const app = createApp();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/affiliates",
    payload: { name: "a", email: "oversized@example.com", padding: "x".repeat(1_100_000) }
  });

  assert.equal(response.statusCode, 413);
  await app.close();
});
