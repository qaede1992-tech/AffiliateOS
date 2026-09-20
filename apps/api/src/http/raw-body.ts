import type { FastifyRequest } from "fastify";
import { Readable } from "node:stream";

const rawBodies = new WeakMap<object, string>();

export async function captureRawBody(request: FastifyRequest, payload: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    payload.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    payload.on("end", resolve);
    payload.on("error", reject);
  });
  const buffer = Buffer.concat(chunks);
  rawBodies.set(request, buffer.toString("utf8"));
  return Readable.from([buffer]);
}

export function getRawBody(request: FastifyRequest): string | undefined {
  return rawBodies.get(request);
}
