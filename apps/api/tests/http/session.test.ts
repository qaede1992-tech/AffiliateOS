import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";

const auth = {
  enabled: true,
  token: "test-api-token-with-enough-length-for-session",
  operatorId: "operator-test",
  role: "operator" as const
};

test("browser login creates an HttpOnly session cookie accepted by protected routes", async () => {
  const app = createApp(undefined, { auth, rateLimit: { enabled: false, limit: 10, windowMs: 60_000 } });

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { token: auth.token }
  });
  assert.equal(login.statusCode, 200);
  assert.match(String(login.headers["set-cookie"]), /affiliateos_session=/);
  assert.match(String(login.headers["set-cookie"]), /HttpOnly/);
  assert.match(String(login.headers["set-cookie"]), /SameSite=Strict/);

  const sessionCookie = String(login.headers["set-cookie"]).split(";")[0];
  const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: sessionCookie } });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), { authenticated: true, operatorId: auth.operatorId, role: auth.role });

  await app.close();
});

test("invalid browser login does not create a session", async () => {
  const app = createApp(undefined, { auth, rateLimit: { enabled: false, limit: 10, windowMs: 60_000 } });
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token: "wrong-token" } });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["set-cookie"], undefined);
  await app.close();
});

test("logout clears the browser session cookie", async () => {
  const app = createApp(undefined, { auth, rateLimit: { enabled: false, limit: 10, windowMs: 60_000 } });
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["set-cookie"]), /Max-Age=0/);
  await app.close();
});
