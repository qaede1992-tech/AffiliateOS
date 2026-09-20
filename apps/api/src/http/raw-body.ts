import type { FastifyRequest } from "fastify";
import { Readable } from "node:stream";

const rawBodies = new WeakMap<object, string>();

export async function captureRawBody(request: FastifyRequest, payload: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  const rawBody = Buffer.concat(chunks).toString("utf8");
  rawBodies.set(request, rawBody);
  return Readable.from([Buffer.concat(chunks)]);
}

export function getRawBody(request: FastifyRequest): string | undefined {
  return rawBodies.get(request);
}
