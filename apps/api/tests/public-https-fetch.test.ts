import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
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


test("blocks Shopee hosts and redirect destinations before requesting them", async () => {
  let lookups = 0;
  let requests = 0;
  const resolveHost = (async () => {
    lookups++;
    return [{ address: "8.8.8.8", family: 4 }];
  }) as never;
  const fetchImpl = ((options: unknown, callback: (response: EventEmitter & { statusCode?: number; headers?: Record<string, string>; resume: () => void }) => void) => {
    requests++;
    const response = new EventEmitter() as EventEmitter & { statusCode?: number; headers?: Record<string, string>; resume: () => void };
    response.statusCode = 302;
    response.headers = { location: "https://shopee.co.id/product/1/2" };
    response.resume = () => {};
    callback(response);
    const request = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void; destroy: () => void };
    request.setTimeout = () => {};
    request.end = () => {};
    request.destroy = () => {};
    return request;
  }) as never;

  await assert.rejects(
    () => fetchPublicHttps("https://shop.example.test/product/1", {
      maxBytes: 100, resolveHost, fetchImpl, blockedHostnames: ["shopee.co.id", "shopee.com"]
    }),
    /blocked by the fetch policy/
  );
  assert.equal(lookups, 1);
  assert.equal(requests, 1);
});

test("enforces allowed hostnames before DNS resolution", async () => {
  let lookups = 0;
  let requests = 0;
  const resolveHost = (async () => {
    lookups++;
    return [{ address: "8.8.8.8", family: 4 }];
  }) as never;
  const fetchImpl = (() => {
    requests++;
    throw new Error("request should not occur");
  }) as never;

  await assert.rejects(
    () => fetchPublicHttps("https://cdn.example.test/image.jpg", {
      maxBytes: 100, resolveHost, fetchImpl, allowedHosts: ["shopee.co.id", "shopee.com"]
    }),
    /not allowed by the fetch policy/
  );
  assert.equal(lookups, 0);
  assert.equal(requests, 0);
});

test("does not follow redirects outside allowed hostnames", async () => {
  let lookups = 0;
  let requests = 0;
  const resolveHost = (async () => {
    lookups++;
    return [{ address: "8.8.8.8", family: 4 }];
  }) as never;
  const fetchImpl = ((options: unknown, callback: (response: EventEmitter & { statusCode?: number; headers?: Record<string, string>; resume: () => void }) => void) => {
    requests++;
    const response = new EventEmitter() as EventEmitter & { statusCode?: number; headers?: Record<string, string>; resume: () => void };
    response.statusCode = 302;
    response.headers = { location: "https://cdn.example.test/redirected-file" };
    response.resume = () => {};
    callback(response);
    const request = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void; destroy: () => void };
    request.setTimeout = () => {};
    request.end = () => {};
    request.destroy = () => {};
    return request;
  }) as never;

  await assert.rejects(
    () => fetchPublicHttps("https://s.shopee.co.id/short", {
      maxBytes: 100, resolveHost, fetchImpl, allowedHosts: ["shopee.co.id", "shopee.com"]
    }),
    /not allowed by the fetch policy/
  );
  assert.equal(lookups, 1);
  assert.equal(requests, 1);
});
