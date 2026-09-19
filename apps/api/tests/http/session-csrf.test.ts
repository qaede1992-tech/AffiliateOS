import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";

const auth = {
  enabled: true,
  token: "test-api-token-with-enough-length-for-session",
  operatorId: "operator-test",
  role: "operator" as const
};

async function loginCookie(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { token: auth.token },
    headers: { origin: "http://localhost:5173" }
  });
  assert.equal(response.statusCode, 200);
  return String(response.headers["set-cookie"]).split(";")[0];
}

test("session-authenticated state changes reject an untrusted origin", async () => {
  const app = createApp(undefined, { auth, rateLimit: { enabled: false, limit: 10, windowMs: 60_000 } });
  const cookie = await loginCookie(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/campaigns",
    headers: { cookie, origin: "https://evil.example" },
    payload: {}
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "CSRF_ORIGIN_REJECTED");
  await app.close();
});

test("session-authenticated state changes accept the configured origin", async () => {
  const app = createApp(undefined, { auth, rateLimit: { enabled: false, limit: 10, windowMs: 60_000 } });
  const cookie = await loginCookie(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/campaigns",
    headers: { cookie, origin: "http://localhost:5173" },
    payload: {}
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "VALIDATION_ERROR");
  await app.close();
});

test("bearer-authenticated state changes do not require a browser origin", async () => {
  const app = createApp(undefined, { auth, rateLimit: { enabled: false, limit: 10, windowMs: 60_000 } });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/campaigns",
    headers: { authorization: `Bearer ${auth.token}` },
    payload: {}
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "VALIDATION_ERROR");
  await app.close();
});
