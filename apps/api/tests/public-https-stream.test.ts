import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fetchPublicHttpsStream } from "../src/domain/public-https-stream.js";

test("streaming media fetch rejects private DNS answers before opening a socket", async () => {
  let requestOpened = false;
  await assert.rejects(
    () => fetchPublicHttpsStream("https://media.example.test/video.mp4", { method: "GET" }, {
      maxBytes: 1024,
      resolveHost: (async () => [{ address: "127.0.0.1", family: 4 }]) as never,
      requestImpl: (() => {
        requestOpened = true;
        throw new Error("socket must not open");
      }) as never
    }),
    /private or special-use address/i
  );
  assert.equal(requestOpened, false);
});

test("streaming media fetch rejects IP-literal and credential-bearing URLs", async () => {
  const options = {
    maxBytes: 1024,
    resolveHost: (async () => [{ address: "93.184.216.34", family: 4 }]) as never
  };
  await assert.rejects(
    () => fetchPublicHttpsStream("https://127.0.0.1/video.mp4", { method: "GET" }, options),
    /public HTTPS URL/i
  );
  await assert.rejects(
    () => fetchPublicHttpsStream("https://user:pass@media.example.test/video.mp4", { method: "GET" }, options),
    /public HTTPS URL/i
  );
});

test("streaming media fetch re-resolves redirect hosts and blocks DNS rebinding to private IPs", async () => {
  let resolutionCount = 0;
  let requestCount = 0;
  const resolver = (async () => {
    resolutionCount += 1;
    return resolutionCount === 1
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "10.0.0.8", family: 4 }];
  }) as never;
  const requestImpl = ((_options: unknown, callback: (response: PassThrough & {
    statusCode?: number;
    headers: Record<string, string>;
  }) => void) => {
    requestCount += 1;
    const request = new EventEmitter() as EventEmitter & {
      setTimeout: () => void;
      end: () => void;
      destroy: (error?: Error) => void;
    };
    request.setTimeout = () => undefined;
    request.destroy = () => undefined;
    request.end = () => {
      const response = new PassThrough() as PassThrough & {
        statusCode?: number;
        headers: Record<string, string>;
      };
      response.statusCode = 302;
      response.headers = { location: "https://redirect.example.test/video.mp4" };
      callback(response);
      response.end();
    };
    return request;
  }) as never;

  await assert.rejects(
    () => fetchPublicHttpsStream("https://media.example.test/video.mp4", { method: "GET" }, {
      maxBytes: 1024,
      resolveHost: resolver,
      requestImpl
    }),
    /private or special-use address/i
  );
  assert.equal(resolutionCount, 2);
  assert.equal(requestCount, 1);
});
