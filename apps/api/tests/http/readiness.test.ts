import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";

test("GET /api/v1/ready returns ready when the dependency check succeeds", async () => {
  const app = createApp(undefined, { readinessCheck: async () => {} });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/ready",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ready",
    service: "affiliateos-api",
  });

  await app.close();
});

test("GET /api/v1/ready returns 503 when the dependency check fails", async () => {
  const app = createApp(undefined, {
    readinessCheck: async () => {
      throw new Error("database unavailable");
    },
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/ready",
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: "not_ready",
    service: "affiliateos-api",
  });

  await app.close();
});
