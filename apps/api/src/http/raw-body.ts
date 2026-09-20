import type { FastifyRequest } from "fastify";
import { Readable } from "node:stream";

const rawBodies = new WeakMap<object, string>();

export async function captureRawBody(request: FastifyRequest, payload: NodeJS.ReadableStream | Buffer | string | unknown) {
  if (payload && typeof (payload as { on?: unknown }).on === "function") {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = payload as NodeJS.ReadableStream;
      stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    const buffer = Buffer.concat(chunks);
    rawBodies.set(request, buffer.toString("utf8"));
    return Readable.from([buffer]);
  }

  const raw = Buffer.isBuffer(payload) ? payload.toString("utf8") : typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  rawBodies.set(request, raw);
  return Readable.from([Buffer.from(raw, "utf8")]);
}

export function getRawBody(request: FastifyRequest): string | undefined {
  return rawBodies.get(request);
}
