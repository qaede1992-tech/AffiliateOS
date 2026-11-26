import assert from "node:assert/strict";
import test from "node:test";
import { IllustrativeMediaTokenSigner } from "../../src/domain/illustrative-media-token.js";

const signer = new IllustrativeMediaTokenSigner("test-only-illustrative-media-secret-32-bytes-min");
const claims = {
  creativeId: "11111111-1111-4111-8111-111111111111",
  mediaAssetId: "22222222-2222-4222-8222-222222222222",
  contentId: "33333333-3333-4333-8333-333333333333",
  sha256: "a".repeat(64),
  expiresAtSeconds: null
};

test("verifies lifecycle-revoked token without inventing an external processing TTL", () => {
  const token = signer.sign(claims, 100);
  assert.deepEqual(signer.verify(token, claims, 999999999), claims);
});

test("still binds lifecycle-revoked token to one creative, asset, content, and hash", () => {
  const token = signer.sign(claims, 100);
  assert.throws(() => signer.verify(token, { ...claims, contentId: "44444444-4444-4444-8444-444444444444" }, 101));
  assert.throws(() => signer.verify(token, { ...claims, sha256: "b".repeat(64) }, 101));
  assert.throws(() => signer.verify(token, claims, -1));
});
