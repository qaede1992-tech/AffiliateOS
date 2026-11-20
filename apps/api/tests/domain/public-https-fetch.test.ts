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


test("applies the total fetch deadline while DNS resolution is pending", async () => {
  let requestStarted = false;
  const requestImpl = (() => {
    requestStarted = true;
    throw new Error("request must not start after DNS exhausts the total deadline");
  }) as never;

  await assert.rejects(
    fetchPublicHttps("https://media.example.test/image.jpg", {
      maxBytes: 1024,
      timeoutMs: 20,
      resolveHost: (() => new Promise(() => undefined)) as never,
      fetchImpl: requestImpl
    }),
    /total deadline during DNS resolution/
  );
  assert.equal(requestStarted, false);
});

test("shares one deadline budget across redirect hops", async () => {
  const requestTimeouts: number[] = [];
  let requestCount = 0;
  let secondRequestDestroyed = false;

  const requestImpl = ((_options: unknown, callback: (incoming: IncomingMessage) => void) => {
    requestCount += 1;
    const currentRequest = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      setTimeout: (timeout: number, callback: () => void) => typeof currentRequest;
      end: () => void;
      destroy: (error?: Error) => typeof currentRequest;
    };
    currentRequest.destroyed = false;
    currentRequest.setTimeout = (timeout: number) => {
      requestTimeouts.push(timeout);
      return currentRequest;
    };
    currentRequest.destroy = (error?: Error) => {
      currentRequest.destroyed = true;
      if (requestCount === 2) secondRequestDestroyed = true;
      if (error) queueMicrotask(() => currentRequest.emit("error", error));
      return currentRequest;
    };
    currentRequest.end = () => {
      if (requestCount === 1) {
        const redirect = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          resume: () => void;
        };
        redirect.statusCode = 302;
        redirect.headers = { location: "/second.jpg" };
        redirect.resume = () => { setTimeout(() => redirect.emit("end"), 25); };
        queueMicrotask(() => callback(redirect as unknown as IncomingMessage));
        return;
      }

      const response = new SlowResponse();
      queueMicrotask(() => {
        callback(response as unknown as IncomingMessage);
        response.start();
      });
      currentRequest.once("error", () => response.stop());
    };
    return currentRequest as unknown as ClientRequest;
  }) as never;

  await assert.rejects(
    fetchPublicHttps("https://media.example.test/first.jpg", {
      maxBytes: 1024,
      timeoutMs: 120,
      resolveHost: (async () => [{ address: "8.8.8.8", family: 4 }]) as never,
      fetchImpl: requestImpl
    }),
    /absolute transfer deadline/
  );

  assert.equal(requestCount, 2, "the redirect should reach exactly one second request");
  assert.equal(requestTimeouts.length, 2);
  assert.ok(
    requestTimeouts[1]! < requestTimeouts[0]!,
    "the second redirect hop must receive only the remaining total deadline budget"
  );
  assert.equal(secondRequestDestroyed, true, "the shared deadline must terminate the second request");
});
