import assert from "node:assert/strict";
import test from "node:test";
import { isStructurallyValidMedia } from "../src/domain/media-file-validation.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l0sAAAAASUVORK5CYII=",
  "base64"
);

test("accepts a PNG with a complete chunk structure", () => {
  assert.equal(isStructurallyValidMedia("image/png", tinyPng), true);
});

test("rejects a PNG containing only its signature", () => {
  assert.equal(isStructurallyValidMedia("image/png", Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])), false);
});

test("rejects truncated PNG chunks", () => {
  assert.equal(isStructurallyValidMedia("image/png", tinyPng.subarray(0, 24)), false);
});

test("rejects JPEG signature without frame and end marker", () => {
  assert.equal(isStructurallyValidMedia("image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])), false);
});

test("rejects a WebP header with inconsistent RIFF length", () => {
  const fake = Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBPVP8 ");
  assert.equal(isStructurallyValidMedia("image/webp", fake), false);
});

test("rejects an MP4 ftyp signature without complete boxes", () => {
  const fake = Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  assert.equal(isStructurallyValidMedia("video/mp4", fake), false);
});

test("rejects MIME types that are not supported", () => {
  assert.equal(isStructurallyValidMedia("text/plain", Buffer.from("hello")), false);
});
