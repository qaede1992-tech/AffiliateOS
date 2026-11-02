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


test("rejects an initial hostname outside the optional allowlist before DNS resolution", async () => {
  let lookups = 0;
  let requests = 0;
  const resolveHost = (async () => {
    lookups += 1;
    return [{ address: "8.8.8.8", family: 4 }];
  }) as never;
  const fetchImpl = (() => {
    requests += 1;
    throw new Error("request should not occur");
  }) as never;

  await assert.rejects(
    () => fetchPublicHttps("https://example.com/image.jpg", {
      maxBytes: 100,
      allowedHosts: ["shopee.co.id", "shopee.com"],
      resolveHost,
      fetchImpl
    }),
    /allowed host list/
  );
  assert.equal(lookups, 0);
  assert.equal(requests, 0);
});

test("rejects redirect destinations outside the optional allowlist before DNS resolution", async () => {
  const resolvedHosts: string[] = [];
  const requestedHosts: string[] = [];
  const fetchImpl = ((options: { hostname: string }, callback: (response: unknown) => void) => {
    requestedHosts.push(options.hostname);
    const request = new EventEmitter() as EventEmitter & {
      setTimeout: (timeoutMs: number, callback?: () => void) => unknown;
      end: () => void;
      destroy: (error?: Error) => unknown;
    };
    request.setTimeout = () => request;
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        resume: () => void;
      };
      response.statusCode = 302;
      response.headers = { location: "https://example.com/redirected" };
      response.resume = () => {};
      queueMicrotask(() => callback(response));
    };
    request.destroy = (error?: Error) => {
      if (error) request.emit("error", error);
      return request;
    };
    return request;
  }) as never;
  const resolveHost = (async (hostname: string) => {
    resolvedHosts.push(hostname);
    return [{ address: "8.8.8.8", family: 4 }];
  }) as never;

  await assert.rejects(
    () => fetchPublicHttps("https://s.shopee.co.id/short", {
      maxBytes: 100,
      allowedHosts: ["shopee.co.id", "shopee.com"],
      resolveHost,
      fetchImpl
    }),
    /allowed host list/
  );
  assert.deepEqual(resolvedHosts, ["s.shopee.co.id"]);
  assert.deepEqual(requestedHosts, ["s.shopee.co.id"]);
});
