import assert from "node:assert/strict";
import test from "node:test";
import { parseSingleByteRange } from "../../src/domain/byte-range.js";

test("parses closed, open-ended, and suffix ranges", () => {
  assert.deepEqual(parseSingleByteRange("bytes=2-5", 10), { kind: "partial", start: 2, end: 5, length: 4 });
  assert.deepEqual(parseSingleByteRange("bytes=8-", 10), { kind: "partial", start: 8, end: 9, length: 2 });
  assert.deepEqual(parseSingleByteRange("bytes=-3", 10), { kind: "partial", start: 7, end: 9, length: 3 });
});

test("clamps end offsets and rejects valid but unsatisfiable ranges", () => {
  assert.deepEqual(parseSingleByteRange("bytes=8-99", 10), { kind: "partial", start: 8, end: 9, length: 2 });
  assert.deepEqual(parseSingleByteRange("bytes=10-", 10), { kind: "unsatisfiable" });
  assert.deepEqual(parseSingleByteRange("bytes=-0", 10), { kind: "unsatisfiable" });
});

test("ignores malformed and multi-range requests", () => {
  assert.deepEqual(parseSingleByteRange("bytes=1-2,4-5", 10), { kind: "full" });
  assert.deepEqual(parseSingleByteRange("items=1-2", 10), { kind: "full" });
  assert.deepEqual(parseSingleByteRange("bytes=999999999999999999999-", 10), { kind: "full" });
});

test("rejects invalid media sizes", () => {
  assert.throws(() => parseSingleByteRange("bytes=0-1", -1));
  assert.throws(() => parseSingleByteRange("bytes=0-1", Number.MAX_SAFE_INTEGER + 1));
});
