export type ByteRangeResult =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number; length: number }
  | { kind: "unsatisfiable" };

export function parseSingleByteRange(header: string | undefined, size: number): ByteRangeResult {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Media size must be a non-negative safe integer.");
  if (header === undefined) return { kind: "full" };
  const value = header.trim();
  if (!value || value.length > 128) return { kind: "full" };
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
    const suffix = parseSafe(rawEnd);
    if (suffix === undefined) return { kind: "full" };
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    const length = Math.min(suffix, size), start = size - length;
    return { kind: "partial", start, end: size - 1, length };
  }
  const start = parseSafe(rawStart), requestedEnd = parseSafe(rawEnd);
  if (start === undefined || (rawEnd && requestedEnd === undefined)) return { kind: "full" };
  if (size === 0 || start >= size || (requestedEnd !== undefined && requestedEnd < start)) return { kind: "unsatisfiable" };
  const end = Math.min(requestedEnd ?? size - 1, size - 1);
  return { kind: "partial", start, end, length: end - start + 1 };
}
