import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductMediaPreviewToken,
  verifyProductMediaPreviewToken,
  type ProductMediaPreviewTokenConfig
} from "../../src/domain/product-media-preview-token.js";

const now = Date.parse("2026-11-27T00:00:00.000Z");
const config: ProductMediaPreviewTokenConfig = {
  signingKey: "preview-signing-key-for-tests-only-32",
  maximumLifetimeSeconds: 300
};
const claims = {
  assetId: "11111111-1111-4111-8111-111111111111",
  productId: "22222222-2222-4222-8222-222222222222",
  sha256: "a".repeat(64),
  expiresAt: Math.floor(now / 1000) + 120
};

test("signs and verifies a short-lived token bound to one product media asset", () => {
  const token = createProductMediaPreviewToken(claims, config, now);
  assert.deepEqual(verifyProductMediaPreviewToken(token, config, now), { version: 1, ...claims });
});

test("rejects modified signatures, different keys and expired tokens", () => {
  const token = createProductMediaPreviewToken(claims, config, now);
  const [payload, signature] = token.split(".");
  assert.throws(() => verifyProductMediaPreviewToken(`${payload}.${signature!.slice(0, -1)}A`, config, now), /Invalid/);
  assert.throws(() => verifyProductMediaPreviewToken(token, { ...config, signingKey: "different-preview-key-with-at-least-32" }, now), /Invalid/);
  assert.throws(() => verifyProductMediaPreviewToken(token, config, now + 121_000), /expired/);
});

test("rejects malformed claims and token lifetimes beyond policy", () => {
  assert.throws(() => createProductMediaPreviewToken({ ...claims, assetId: "../asset" }, config, now), /Invalid/);
  assert.throws(() => createProductMediaPreviewToken({ ...claims, expiresAt: Math.floor(now / 1000) + 301 }, config, now), /outside/);
});
