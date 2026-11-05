import assert from "node:assert/strict";
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
