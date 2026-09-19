import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRateLimiter, configuredRateLimit } from "../../src/http/rate-limit.js";
import { createApp } from "../../src/app.js";

const auth = {
  enabled: true,
  token: "test-api-token",
  operatorId: "operator-test",
  role: "operator" as const
};

test("rate limiter enforces a fixed window and reports remaining capacity", () => {
  const limiter = new InMemoryRateLimiter(2, 60_000);
  const first = limiter.consume("client", 1_000);
  const second = limiter.consume("client", 2_000);
  const third = limiter.consume("client", 3_000);
  const nextWindow = limiter.consume("client", 61_000);

  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 1);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfterSeconds, 58);
  assert.equal(nextWindow.allowed, true);
  assert.equal(nextWindow.remaining, 1);
});

test("rate limiter keeps clients isolated", () => {
  const limiter = new InMemoryRateLimiter(1, 60_000);

  assert.equal(limiter.consume("a", 1_000).allowed, true);
  assert.equal(limiter.consume("a", 2_000).allowed, false);
  assert.equal(limiter.consume("b", 2_000).allowed, true);
});

test("rate limiter bounds active client buckets", () => {
  const limiter = new InMemoryRateLimiter(1, 60_000, 2);

  assert.equal(limiter.consume("a", 1_000).allowed, true);
  assert.equal(limiter.consume("b", 1_000).allowed, true);
  assert.equal(limiter.consume("c", 1_000).allowed, true);
  assert.equal(limiter.consume("c", 2_000).allowed, false);

  // The oldest active bucket is evicted when the configured capacity is full.
  assert.equal(limiter.consume("a", 2_000).allowed, true);
});

test("rate limiter removes expired buckets before admitting a new client", () => {
  const limiter = new InMemoryRateLimiter(1, 1_000, 2);

  assert.equal(limiter.consume("a", 1_000).allowed, true);
  assert.equal(limiter.consume("b", 1_000).allowed, true);
  assert.equal(limiter.consume("c", 2_000).allowed, true);

  // Both prior buckets expired, so admitting c does not evict an active bucket.
  assert.equal(limiter.consume("b", 2_000).allowed, true);
});

test("authenticated API routes return rate-limit headers and 429 when exhausted", async () => {
  const app = createApp(undefined, {
    auth,
    rateLimit: { enabled: true, limit: 2, windowMs: 60_000 }
  });

  const headers = { authorization: "Bearer test-api-token" };
  const first = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers });
  const second = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers });
  const third = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers });

  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["x-ratelimit-limit"], "2");
  assert.equal(first.headers["x-ratelimit-remaining"], "1");
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["x-ratelimit-remaining"], "0");
  assert.equal(third.statusCode, 429);
  assert.equal(third.headers["retry-after"], "60");
  assert.deepEqual(third.json(), {
    error: "RATE_LIMITED",
    message: "Too many requests. Please retry later."
  });

  await app.close();
});

test("health and readiness are not consumed by the application rate limiter", async () => {
  const app = createApp(undefined, {
    auth,
    rateLimit: { enabled: true, limit: 1, windowMs: 60_000 }
  });

  const health = await app.inject({ method: "GET", url: "/api/v1/health" });
  const ready = await app.inject({ method: "GET", url: "/api/v1/ready" });
  const protectedRequest = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { authorization: "Bearer test-api-token" }
  });

  assert.equal(health.statusCode, 200);
  assert.equal(ready.statusCode, 200);
  assert.equal(protectedRequest.statusCode, 200);

  await app.close();
});

test("rate-limit configuration defaults to 120 requests per minute in production", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousMax = process.env.API_RATE_LIMIT_MAX;
  const previousWindow = process.env.API_RATE_LIMIT_WINDOW_MS;

  process.env.NODE_ENV = "production";
  delete process.env.API_RATE_LIMIT_MAX;
  delete process.env.API_RATE_LIMIT_WINDOW_MS;

  assert.deepEqual(configuredRateLimit(), {
    enabled: true,
    limit: 120,
    windowMs: 60_000
  });

  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousMax === undefined) delete process.env.API_RATE_LIMIT_MAX;
  else process.env.API_RATE_LIMIT_MAX = previousMax;
  if (previousWindow === undefined) delete process.env.API_RATE_LIMIT_WINDOW_MS;
  else process.env.API_RATE_LIMIT_WINDOW_MS = previousWindow;
});
