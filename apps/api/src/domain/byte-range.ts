export type ByteRangeResult =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number; length: number }
  | { kind: "unsatisfiable" };

/**
 * Parse one HTTP byte range without allocating or reading media bytes.
 *
 * Malformed, unsupported, and multi-range headers are ignored (full response),
 * while syntactically valid but impossible ranges are reported as 416 candidates.
 * The caller remains responsible for HEAD semantics and response headers.
 */
export function parseSingleByteRange(header: string | undefined, size: number): ByteRangeResult {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Media size must be a non-negative safe integer.");
  }
  if (header === undefined) return { kind: "full" };
  const value = header.trim();
  if (value.length === 0 || value.length > 128) return { kind: "full" };

  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match) return { kind: "full" };

  const [, rawStart = "", rawEnd = ""] = match;
  if (!rawStart && !rawEnd) return { kind: "full" };

  const parseSafe = (part: string): number | undefined => {
    if (!part) return undefined;
    const parsed = Number(part);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  };

  if (!rawStart) {
    const suffixLength = parseSafe(rawEnd);
    if (suffixLength === undefined) return { kind: "full" };
    if (suffixLength === 0 || size === 0) return { kind: "unsatisfiable" };
    const length = Math.min(suffixLength, size);
    const start = size - length;
    return { kind: "partial", start, end: size - 1, length };
  }

  const start = parseSafe(rawStart);
  const requestedEnd = parseSafe(rawEnd);
  if (start === undefined || (rawEnd && requestedEnd === undefined)) return { kind: "full" };
  if (size === 0 || start >= size || (requestedEnd !== undefined && requestedEnd < start)) {
    return { kind: "unsatisfiable" };
  }
  const end = Math.min(requestedEnd ?? size - 1, size - 1);
  return { kind: "partial", start, end, length: end - start + 1 };
}
