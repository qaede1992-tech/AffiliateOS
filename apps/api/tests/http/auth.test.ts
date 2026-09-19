import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";

const auth = {
  enabled: true,
  token: "test-api-token",
  operatorId: "operator-test",
  role: "operator" as const
};

test("protected API routes require bearer authentication", async () => {
  const app = createApp(undefined, { auth });

  const response = await app.inject({ method: "GET", url: "/api/v1/marketplaces" });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {
    error: "UNAUTHORIZED",
    message: "Authentication is required."
  });

  await app.close();
});

test("valid bearer authentication exposes the authenticated operator context", async () => {
  const app = createApp(undefined, { auth });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { authorization: "Bearer test-api-token" }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    authenticated: true,
    operatorId: "operator-test",
    role: "operator"
  });

  await app.close();
});

test("viewer authentication cannot activate a marketplace connection", async () => {
  const app = createApp(undefined, {
    auth: { ...auth, role: "viewer" }
  });

  const response = await app.inject({
    method: "PUT",
    url: "/api/v1/marketplaces/example/enabled",
    headers: { authorization: "Bearer test-api-token" },
    payload: { enabled: true, confirmation: "CONFIRM_MARKETPLACE_CONNECTION" }
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), {
    error: "FORBIDDEN",
    message: "An authorized operator is required."
  });

  await app.close();
});

test("liveness and readiness remain available without authentication", async () => {
  const app = createApp(undefined, { auth });

  const health = await app.inject({ method: "GET", url: "/api/v1/health" });
  const ready = await app.inject({ method: "GET", url: "/api/v1/ready" });

  assert.equal(health.statusCode, 200);
  assert.equal(ready.statusCode, 200);

  await app.close();
});
