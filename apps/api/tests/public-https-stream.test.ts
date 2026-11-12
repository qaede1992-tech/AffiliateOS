import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fetchPublicHttpsStream } from "../src/domain/public-https-stream.js";

test("streaming media fetch rejects private DNS answers before opening a socket", async () => {
  let requestOpened = false;
  await assert.rejects(
    () => fetchPublicHttpsStream("https://media.example.com/video.mp4", { method: "GET" }, {
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
    () => fetchPublicHttpsStream("https://user:pass@media.example.com/video.mp4", { method: "GET" }, options),
    /public HTTPS URL/i
  );
});

test("streaming media fetch rejects local and special-use hostnames before DNS resolution", async () => {
  let resolutions = 0;
  const options = {
    maxBytes: 1024,
    resolveHost: (async () => {
      resolutions += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    }) as never
  };
  for (const url of [
    "https://localhost/video.mp4",
    "https://media.localhost/video.mp4",
    "https://printer.local/video.mp4",
    "https://metadata.internal/video.mp4",
    "https://router.home.arpa/video.mp4",
    "https://asset.test/video.mp4",
    "https://asset.example/video.mp4",
    "https://asset.invalid/video.mp4",
    "https://asset.onion/video.mp4",
    "https://metadata/video.mp4"
  ]) {
    await assert.rejects(
      () => fetchPublicHttpsStream(url, { method: "GET" }, options),
      /credential-free public HTTPS URL/i
    );
  }
  assert.equal(resolutions, 0);
});

test("streaming media fetch bounds DNS resolution by the configured timeout", async () => {
  let requestOpened = false;
  await assert.rejects(
    () => fetchPublicHttpsStream("https://media.example.com/video.mp4", { method: "GET" }, {
      maxBytes: 1024,
      timeoutMs: 10,
      resolveHost: (() => new Promise(() => undefined)) as never,
      requestImpl: (() => {
        requestOpened = true;
        throw new Error("socket must not open");
      }) as never
    }),
    /DNS lookup exceeded the configured timeout/i
  );
  assert.equal(requestOpened, false);
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
      response.headers = { location: "https://redirect.example.com/video.mp4" };
      callback(response);
      response.end();
    };
    return request;
  }) as never;

  await assert.rejects(
    () => fetchPublicHttpsStream("https://media.example.com/video.mp4", { method: "GET" }, {
      maxBytes: 1024,
      resolveHost: resolver,
      requestImpl
    }),
    /private or special-use address/i
  );
  assert.equal(resolutionCount, 2);
  assert.equal(requestCount, 1);
});


test("streaming media fetch rejects successful GET responses that cannot carry a body", async () => {
  const requestImpl = ((_options: unknown, callback: (response: PassThrough & {
    statusCode?: number;
    headers: Record<string, string>;
  }) => void) => {
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
      response.statusCode = 204;
      response.headers = {};
      callback(response);
      response.end();
    };
    return request;
  }) as never;

  await assert.rejects(
    () => fetchPublicHttpsStream("https://media.example.com/video.mp4", { method: "GET" }, {
      maxBytes: 1024,
      resolveHost: (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
      requestImpl
    }),
    /without a usable media body/i
  );
});


test("streaming media fetch rejects non-global 192.0.0.0/24 protocol assignments", async () => {
  for (const address of ["192.0.0.1", "192.0.0.8", "192.0.0.170", "192.0.0.171"]) {
    let requestOpened = false;
    await assert.rejects(
      () => fetchPublicHttpsStream("https://media.example.com/video.mp4", { method: "GET" }, {
        maxBytes: 1024,
        resolveHost: (async () => [{ address, family: 4 }]) as never,
        requestImpl: (() => {
          requestOpened = true;
          throw new Error("socket must not open");
        }) as never
      }),
      /private or special-use address/i
    );
    assert.equal(requestOpened, false, address + " must be rejected before opening a socket");
  }
});


test("streaming media fetch rejects IANA IPv6 non-global and documentation ranges", async () => {
  for (const address of ["2001::1", "2001:1ff::1", "2001:0db8:0:0:0:0:0:1", "3fff::1"]) {
    let requestOpened = false;
    await assert.rejects(
      () => fetchPublicHttpsStream("https://media.example.com/video.mp4", { method: "GET" }, {
        maxBytes: 1024,
        resolveHost: (async () => [{ address, family: 6 }]) as never,
        requestImpl: (() => {
          requestOpened = true;
          throw new Error("socket must not open");
        }) as never
      }),
      /private or special-use address/i
    );
    assert.equal(requestOpened, false, address + " must be rejected before opening a socket");
  }
});


test("streaming media fetch disables pooled HTTPS agents so each request uses its validated DNS pin", async () => {
  let observedOptions: unknown;
  const requestImpl = ((_options: unknown, callback: (response: PassThrough & {
    statusCode?: number;
    headers: Record<string, string>;
  }) => void) => {
    observedOptions = _options;
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
      response.statusCode = 200;
      response.headers = { "content-length": "0" };
      callback(response);
      response.end();
    };
    return request;
  }) as never;

  const response = await fetchPublicHttpsStream("https://media.example.com/video.mp4", { method: "HEAD" }, {
    maxBytes: 1024,
    resolveHost: (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
    requestImpl
  });

  assert.equal(response.status, 200);
  assert.equal((observedOptions as { agent?: unknown } | undefined)?.agent, false);
});


test("streaming media fetch destroys the upstream request when its response body is cancelled", async () => {
  let requestDestroyed = false;
  let incoming: PassThrough | undefined;
  const requestImpl = ((_options: unknown, callback: (response: PassThrough & {
    statusCode?: number;
    headers: Record<string, string>;
  }) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      setTimeout: () => void;
      end: () => void;
      destroy: (error?: Error) => void;
    };
    request.setTimeout = () => undefined;
    request.destroy = () => {
      requestDestroyed = true;
      incoming?.destroy();
    };
    request.end = () => {
      incoming = new PassThrough() as PassThrough & {
        statusCode?: number;
        headers: Record<string, string>;
      };
      incoming.statusCode = 200;
      incoming.headers = {};
      callback(incoming);
      incoming.write(Buffer.from("streaming video bytes"));
    };
    return request;
  }) as never;

  const response = await fetchPublicHttpsStream("https://media.example.com/video.mp4", { method: "GET" }, {
    maxBytes: 1024,
    resolveHost: (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
    requestImpl
  });

  assert.ok(response.body);
  await response.body.cancel();
  assert.equal(requestDestroyed, true);
});


test("streaming media fetch enforces an absolute deadline against slow-drip responses", async () => {
  let incoming: (PassThrough & { statusCode?: number; headers: Record<string, string> }) | undefined;
  let requestError: Error | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const requestImpl = ((_options: unknown, callback: (response: PassThrough & {
    statusCode?: number;
    headers: Record<string, string>;
  }) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      setTimeout: () => void;
      end: () => void;
      destroy: (error?: Error) => void;
    };
    request.setTimeout = () => undefined;
    request.destroy = (error?: Error) => {
      if (error) {
        requestError = error;
        incoming?.destroy(error);
        request.emit("error", error);
      } else {
        incoming?.destroy();
      }
    };
    request.end = () => {
      incoming = new PassThrough() as PassThrough & {
        statusCode?: number;
        headers: Record<string, string>;
      };
      incoming.statusCode = 200;
      incoming.headers = {};
      incoming.once("close", () => {
        if (interval) clearInterval(interval);
      });
      callback(incoming);
      interval = setInterval(() => incoming?.write(Buffer.from("x")), 10);
    };
    return request;
  }) as never;

  const response = await fetchPublicHttpsStream("https://media.example.com/video.mp4", { method: "GET" }, {
    maxBytes: 1024,
    timeoutMs: 60,
    resolveHost: (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
    requestImpl
  });

  await assert.rejects(() => response.arrayBuffer(), /absolute transfer deadline/i);
  assert.match(requestError?.message ?? "", /absolute transfer deadline/i);
  if (interval) clearInterval(interval);
});


test("streaming media fetch rejects a response that closes before it completes", async () => {
  let incoming: PassThrough | undefined;
  const requestImpl = ((_options: unknown, callback: (response: PassThrough & {
    statusCode?: number;
    headers: Record<string, string>;
  }) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      setTimeout: () => void;
      end: () => void;
      destroy: (error?: Error) => void;
    };
    request.setTimeout = () => undefined;
    request.destroy = () => undefined;
    request.end = () => {
      incoming = new PassThrough() as PassThrough & {
        statusCode?: number;
        headers: Record<string, string>;
      };
      incoming.statusCode = 200;
      incoming.headers = {};
      callback(incoming);
      incoming.write(Buffer.from("partial video bytes"));
      setImmediate(() => incoming?.destroy());
    };
    return request;
  }) as never;

  const response = await fetchPublicHttpsStream("https://media.example.com/video.mp4", { method: "GET" }, {
    maxBytes: 1024,
    timeoutMs: 1000,
    resolveHost: (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
    requestImpl
  });

  await assert.rejects(
    () => response.arrayBuffer(),
    /closed before the response completed/i
  );
});
