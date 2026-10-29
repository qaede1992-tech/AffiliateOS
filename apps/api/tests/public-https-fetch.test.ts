import assert from "node:assert/strict";
import test from "node:test";
import { fetchPublicHttps } from "../src/domain/public-https-fetch.js";

test("rejects unsafe URLs before DNS resolution", async () => {
  let lookups = 0;
  const resolveHost = (async () => {
    lookups++;
    return [{ address: "8.8.8.8", family: 4 }];
  }) as never;
  await assert.rejects(() => fetchPublicHttps("http://example.com/image.jpg", { maxBytes: 100, resolveHost }));
  await assert.rejects(() => fetchPublicHttps("https://127.0.0.1/image.jpg", { maxBytes: 100, resolveHost }));
  await assert.rejects(() => fetchPublicHttps("https://user:pass@example.com/image.jpg", { maxBytes: 100, resolveHost }));
  assert.equal(lookups, 0);
});

test("rejects hostnames with any private or special-use DNS answer", async () => {
  const resolveHost = (async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "192.168.1.5", family: 4 }
  ]) as never;
  await assert.rejects(() => fetchPublicHttps("https://cdn.example.com/image.jpg", { maxBytes: 100, resolveHost }), /private or special-use/);
});

test("rejects local hostnames and redirect destinations before requesting them", async () => {
  let requested = 0;
  const fetchImpl = (() => {
    requested++;
    throw new Error("request should not occur");
  }) as never;
  const resolveHost = (async () => [{ address: "8.8.8.8", family: 4 }]) as never;
  await assert.rejects(() => fetchPublicHttps("https://localhost/image.jpg", { maxBytes: 100, resolveHost, fetchImpl }));
  assert.equal(requested, 0);
});
