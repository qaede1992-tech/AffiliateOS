import assert from "node:assert/strict";
import test from "node:test";
import { parseSingleByteRange } from "../../src/domain/byte-range.js";

test("returns full response when no Range header is supplied", () => {
  assert.deepEqual(parseSingleByteRange(undefined, 100), { kind: "full" });
});

test("parses bounded and open-ended byte ranges", () => {
  assert.deepEqual(parseSingleByteRange("bytes=10-19", 100), {
    kind: "partial", start: 10, end: 19, length: 10
  });
  assert.deepEqual(parseSingleByteRange("bytes=90-", 100), {
    kind: "partial", start: 90, end: 99, length: 10
  });
});

test("parses suffix ranges and clamps oversized ends", () => {
  assert.deepEqual(parseSingleByteRange("bytes=-10", 100), {
    kind: "partial", start: 90, end: 99, length: 10
  });
  assert.deepEqual(parseSingleByteRange("bytes=-200", 100), {
    kind: "partial", start: 0, end: 99, length: 100
  });
  assert.deepEqual(parseSingleByteRange("bytes=95-500", 100), {
    kind: "partial", start: 95, end: 99, length: 5
  });
});

test("identifies valid but unsatisfiable ranges", () => {
  assert.deepEqual(parseSingleByteRange("bytes=100-", 100), { kind: "unsatisfiable" });
  assert.deepEqual(parseSingleByteRange("bytes=20-10", 100), { kind: "unsatisfiable" });
  assert.deepEqual(parseSingleByteRange("bytes=-0", 100), { kind: "unsatisfiable" });
  assert.deepEqual(parseSingleByteRange("bytes=0-", 0), { kind: "unsatisfiable" });
});

test("ignores malformed, unsupported, multi-range, and unsafe numeric values", () => {
  for (const header of [
    "", "items=0-1", "bytes=-", "bytes=1-2,4-5", "bytes=1-2-3",
    "bytes=9007199254740992-", "bytes=1-9007199254740992", "bytes=abc-def"
  ]) {
    assert.deepEqual(parseSingleByteRange(header, 100), { kind: "full" }, header);
  }
});

test("rejects invalid media sizes", () => {
  for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(() => parseSingleByteRange("bytes=0-1", size), /non-negative safe integer/);
  }
});
