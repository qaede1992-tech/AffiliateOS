import { PassThrough } from "node:stream";
import type { FastifyRequest } from "fastify";

const rawBodies = new WeakMap<object, string>();

type RawPayload = NodeJS.ReadableStream | Buffer | string | Uint8Array;

export function captureRawBody(request: FastifyRequest, _reply: unknown, payload: RawPayload) {
  if (!payload || typeof (payload as NodeJS.ReadableStream).on !== "function") {
    const body = Buffer.isBuffer(payload)
      ? payload.toString("utf8")
      : typeof payload === "string"
        ? payload
        : Buffer.from(payload as Uint8Array).toString("utf8");
    rawBodies.set(request, body);
    return payload;
  }

  const stream = payload as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  const passthrough = new PassThrough();

  stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  stream.on("end", () => rawBodies.set(request, Buffer.concat(chunks).toString("utf8")));
  const contentLength = request.headers["content-length"];
  if (contentLength) (passthrough as NodeJS.ReadableStream & { receivedEncodedLength?: number }).receivedEncodedLength = Number(contentLength);
  stream.pipe(passthrough);

  return passthrough;
}

export function getRawBody(request: FastifyRequest): string | undefined {
  return rawBodies.get(request);
}
