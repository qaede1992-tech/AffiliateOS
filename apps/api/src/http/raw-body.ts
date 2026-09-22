import { Readable } from "node:stream";
import type { FastifyRequest } from "fastify";

const rawBodies = new WeakMap<object, string>();

type RawPayload = NodeJS.ReadableStream | Buffer | string | Uint8Array;

export function captureRawBody(request: FastifyRequest, _reply: unknown, payload: RawPayload, done: (error: Error | null, payload?: NodeJS.ReadableStream | Buffer | string | Uint8Array) => void) {
  if (!payload || typeof (payload as NodeJS.ReadableStream).on !== "function") {
    const body = Buffer.isBuffer(payload)
      ? payload.toString("utf8")
      : typeof payload === "string"
        ? payload
        : Buffer.from(payload as Uint8Array).toString("utf8");
    rawBodies.set(request, body);
    done(null, payload as Buffer | string | Uint8Array);
    return;
  }

  const stream = payload as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  stream.on("end", () => rawBodies.set(request, Buffer.concat(chunks).toString("utf8")));
  return payload;
}

export function getRawBody(request: FastifyRequest): string | undefined {
  return rawBodies.get(request);
}
