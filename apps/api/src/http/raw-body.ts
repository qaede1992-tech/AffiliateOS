import type { FastifyRequest } from "fastify";

const rawBodies = new WeakMap<object, string>();

export function captureRawBody(request: FastifyRequest, payload: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  payload.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  payload.on("end", () => rawBodies.set(request, Buffer.concat(chunks).toString("utf8")));
  return payload;
}

export function getRawBody(request: FastifyRequest): string | undefined {
  return rawBodies.get(request);
}
