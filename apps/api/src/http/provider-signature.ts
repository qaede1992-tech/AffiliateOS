import { createHmac, timingSafeEqual } from "node:crypto";

export type ProviderSignatureHeaders = {
  signature?: string;
  timestamp?: string;
};

export type ProviderSignatureOptions = {
  maxAgeMs?: number;
  futureSkewMs?: number;
};

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_FUTURE_SKEW_MS = 30 * 1000;
const SIGNATURE_PATTERN = /^(?:t=(?<embeddedTimestamp>\d+),)?v1=(?<signature>[a-f0-9]{64})$/i;

export function verifyProviderEventSignature(rawBody: string, secret: string, headers: ProviderSignatureHeaders, nowMs = Date.now(), options: ProviderSignatureOptions = {}): boolean {
  if (!rawBody || !secret) return false;
  const signatureHeader = headers.signature?.trim();
  const headerTimestamp = headers.timestamp?.trim();
  if (!signatureHeader || !headerTimestamp || !/^\d+$/.test(headerTimestamp)) return false;
  const timestampMs = Number(headerTimestamp) * 1000;
  if (!Number.isSafeInteger(timestampMs)) return false;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const futureSkewMs = options.futureSkewMs ?? DEFAULT_FUTURE_SKEW_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(futureSkewMs) || futureSkewMs < 0) return false;
  const ageMs = nowMs - timestampMs;
  if (ageMs > maxAgeMs || ageMs < -futureSkewMs) return false;
  const match = SIGNATURE_PATTERN.exec(signatureHeader);
  if (!match?.groups?.signature) return false;
  if (match.groups.embeddedTimestamp && match.groups.embeddedTimestamp !== headerTimestamp) return false;
  const expected = createHmac("sha256", secret).update(`${headerTimestamp}.${rawBody}`, "utf8").digest("hex");
  const supplied = match.groups.signature.toLowerCase();
  const expectedBuffer = Buffer.from(expected, "hex");
  const suppliedBuffer = Buffer.from(supplied, "hex");
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export class ProviderReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = DEFAULT_MAX_AGE_MS, private readonly maxEntries = 10_000) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Provider replay TTL must be positive.");
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new Error("Provider replay max entries must be positive.");
  }
  consume(scope: string, eventId: string, nowMs = Date.now()): boolean {
    const normalizedScope = scope.trim();
    const normalizedEventId = eventId.trim();
    if (!normalizedScope || normalizedScope.length > 256 || !normalizedEventId || normalizedEventId.length > 256) return false;
    this.prune(nowMs);
    const key = `${normalizedScope}:${normalizedEventId}`;
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.maxEntries) this.evictOldest();
    this.seen.set(key, nowMs + this.ttlMs);
    return true;
  }
  private prune(nowMs: number): void { for (const [key, expiresAt] of this.seen) if (expiresAt <= nowMs) this.seen.delete(key); }
  private evictOldest(): void { const oldest = this.seen.keys().next().value; if (oldest !== undefined) this.seen.delete(oldest); }
}
