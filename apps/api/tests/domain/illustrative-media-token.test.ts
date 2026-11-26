import assert from "node:assert/strict";
import test from "node:test";
import { IllustrativeMediaTokenSigner } from "../../src/domain/illustrative-media-token.js";

const secret = "test-only-secret-with-at-least-32-bytes";
const context = {
  creativeId: "11111111-1111-4111-8111-111111111111",
  mediaAssetId: "22222222-2222-4222-8222-222222222222",
  contentId: "33333333-3333-4333-8333-333333333333",
  sha256: "a".repeat(64)
};
const claims = { ...context, expiresAtSeconds: 2_000_000_000 };

test("signs and verifies a token bound to one creative, media asset, content, and hash", () => {
  const signer = new IllustrativeMediaTokenSigner(secret);
  const token = signer.sign(claims, 1_900_000_000);
  assert.deepEqual(signer.verify(token, context, 1_900_000_001), claims);
});

test("rejects expired tokens and expiry at the exact boundary", () => {
  const signer = new IllustrativeMediaTokenSigner(secret);
  const token = signer.sign(claims, 1_900_000_000);
  assert.throws(() => signer.verify(token, context, claims.expiresAtSeconds), /Invalid or expired/);
});

test("rejects tampering and a token signed by another secret", () => {
  const signer = new IllustrativeMediaTokenSigner(secret);
  const token = signer.sign(claims, 1_900_000_000);
  const [payload, signature] = token.split(".");
  const first = payload![0] === "A" ? "B" : "A";
  const altered = `${first}${payload!.slice(1)}.${signature}`;
  assert.throws(() => signer.verify(altered, context, 1_900_000_001), /Invalid or expired/);
  assert.throws(() => new IllustrativeMediaTokenSigner("another-secret-with-at-least-32-bytes")
    .verify(token, context, 1_900_000_001), /Invalid or expired/);
});

test("rejects tokens replayed for another creative, media asset, content, or hash", () => {
  const signer = new IllustrativeMediaTokenSigner(secret);
  const token = signer.sign(claims, 1_900_000_000);
  for (const expected of [
    { ...context, creativeId: "44444444-4444-4444-8444-444444444444" },
    { ...context, mediaAssetId: "44444444-4444-4444-8444-444444444444" },
    { ...context, contentId: "44444444-4444-4444-8444-444444444444" },
    { ...context, sha256: "b".repeat(64) }
  ]) {
    assert.throws(() => signer.verify(token, expected, 1_900_000_001), /Invalid or expired/);
  }
});

test("rejects malformed tokens, malformed claims, and short secrets", () => {
  assert.throws(() => new IllustrativeMediaTokenSigner("short"), /at least 32 bytes/);
  const signer = new IllustrativeMediaTokenSigner(secret);
  for (const token of ["", "a.b.c", "not-a-token", ".".repeat(3000)]) {
    assert.throws(() => signer.verify(token, context, 1_900_000_001), /Invalid or expired/);
  }
  assert.throws(() => signer.sign({ ...claims, creativeId: "../escape" }, 1_900_000_000), /claims/);
  assert.throws(() => signer.sign({ ...claims, expiresAtSeconds: 1_900_000_000 }, 1_900_000_000), /future/);
});
