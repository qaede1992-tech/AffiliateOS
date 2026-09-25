import { Readable } from "node:stream";
import type { FastifyRequest } from "fastify";

const rawBodies = new WeakMap<object, string>();

type RawPayload = NodeJS.ReadableStream | Buffer | string | Uint8Array;

export async function captureRawBody(request: FastifyRequest, _reply: unknown, payload: RawPayload) {
  if (!payload || typeof (payload as NodeJS.ReadableStream)[Symbol.asyncIterator] !== "function") {
    const body = Buffer.isBuffer(payload)
      ? payload.toString("utf8")
      : typeof payload === "string"
        ? payload
        : Buffer.from(payload as Uint8Array).toString("utf8");
    rawBodies.set(request, body);
    return payload;
  }

  const stream = payload as NodeJS.ReadableStream & AsyncIterable<Buffer | string | Uint8Array>;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks);
  rawBodies.set(request, body.toString("utf8"));

  const replacement = Readable.from([body]) as Readable & { receivedEncodedLength?: number };
  const contentLength = request.headers["content-length"];
  if (contentLength) replacement.receivedEncodedLength = Number(contentLength);
  return replacement;
}

export function getRawBody(request: FastifyRequest): string | undefined {
  return rawBodies.get(request);
}
