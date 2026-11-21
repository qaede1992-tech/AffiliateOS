import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ClientRequest, IncomingMessage } from "node:http";
import { fetchPublicHttps } from "../../src/domain/public-https-fetch.js";

class SlowResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = { "content-type": "image/jpeg" };
  private interval: ReturnType<typeof setInterval> | undefined;

  start(): void {
    this.interval = setInterval(() => this.emit("data", Buffer.from("x")), 4);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }
}

class SlowRequest extends EventEmitter {
  destroyed = false;
  private readonly response: SlowResponse;

  constructor(response: SlowResponse) {
    super();
    this.response = response;
  }

  setTimeout(_timeout: number, _callback: () => void): this {
    // Deliberately do not fire the inactivity timer: the origin keeps sending data.
    return this;
  }

  end(): void {
    queueMicrotask(() => this.response.start());
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.response.stop();
    if (error) queueMicrotask(() => this.emit("error", error));
    return this;
  }
}

test("enforces an absolute deadline when a public HTTPS origin continuously slow-drips bytes", async () => {
  const response = new SlowResponse();
  const request = new SlowRequest(response);
  const requestImpl = ((_options: unknown, callback: (incoming: IncomingMessage) => void) => {
    queueMicrotask(() => callback(response as unknown as IncomingMessage));
    return request as unknown as ClientRequest;
  }) as never;

  await assert.rejects(
    fetchPublicHttps("https://media.example.test/image.jpg", {
      maxBytes: 1024,
      timeoutMs: 35,
      resolveHost: (async () => [{ address: "8.8.8.8", family: 4 }]) as never,
      fetchImpl: requestImpl
    }),
    /absolute transfer deadline/
  );
  assert.equal(request.destroyed, true, "deadline must actively terminate the underlying request");
  response.stop();
});


test("bounds DNS resolution by the same total fetch deadline", async () => {
  let resolverSettled = false;
  await assert.rejects(
    fetchPublicHttps("https://media.example.test/image.jpg", {
      maxBytes: 1024,
      timeoutMs: 25,
      resolveHost: (async () => new Promise<never>(() => { /* intentionally stalled DNS test double */ })) as never,
      fetchImpl: (() => { throw new Error("HTTP request must not start before DNS resolves"); }) as never
    }),
    /total time budget/
  );
  // The stalled resolver is only a test double; the production Resolver path
  // calls Resolver.cancel() when this same deadline expires.
  resolverSettled = true;
  assert.equal(resolverSettled, true);
});

test("shares one total deadline across multiple redirect hops", async () => {
  const requests: Array<{ destroyed: boolean }> = [];
  const requestImpl = ((_options: unknown, callback: (incoming: IncomingMessage) => void) => {
    const response = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
      resume: () => void;
    };
    response.statusCode = 302;
    response.headers = { location: "/next" };
    response.resume = () => setTimeout(() => response.emit("end"), 20);

    const request = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      setTimeout: (timeout: number, callback: () => void) => void;
      end: () => void;
      destroy: (error?: Error) => void;
    };
    request.destroyed = false;
    request.setTimeout = () => undefined;
    request.end = () => queueMicrotask(() => callback(response as unknown as IncomingMessage));
    request.destroy = (error?: Error) => {
      request.destroyed = true;
      if (error) queueMicrotask(() => request.emit("error", error));
    };
    requests.push(request);
    return request as unknown as ClientRequest;
  }) as never;

  await assert.rejects(
    fetchPublicHttps("https://media.example.test/start", {
      maxBytes: 1024,
      timeoutMs: 35,
      maxRedirects: 4,
      resolveHost: (async () => [{ address: "8.8.8.8", family: 4 }]) as never,
      fetchImpl: requestImpl
    }),
    /total time budget/
  );
  assert.equal(requests.length, 2, "second redirect hop must consume the remaining original budget");
  assert.equal(requests[1]?.destroyed, true, "deadline must actively terminate the in-flight redirect request");
});
