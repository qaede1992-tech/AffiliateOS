import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductMediaDeliveryToken,
  verifyProductMediaDeliveryToken,
  type ProductMediaDeliveryTokenConfig
} from "../../src/domain/product-media-delivery-token.js";

const now = Date.parse("2026-11-27T00:00:00.000Z");
const config: ProductMediaDeliveryTokenConfig = {
  signingKey: "delivery-signing-key-for-tests-only-32",
  maximumLifetimeSeconds: 300
};
const claims = {
  assetId: "11111111-1111-4111-8111-111111111111",
  productId: "22222222-2222-4222-8222-222222222222",
  contentId: "33333333-3333-4333-8333-333333333333",
  reservationId: "44444444-4444-4444-8444-444444444444",
  sha256: "a".repeat(64),
  expiresAt: Math.floor(now / 1000) + 120
};

test("signs and verifies a short-lived token bound to exact media and reservation context", () => {
  const token = createProductMediaDeliveryToken(claims, config, now);
  assert.deepEqual(verifyProductMediaDeliveryToken(token, config, now), { version: 1, ...claims });
});

test("rejects a modified signature and a different signing key", () => {
  const token = createProductMediaDeliveryToken(claims, config, now);
  const [payload, signature] = token.split(".");
  const changed = `${payload}.${signature!.slice(0, -1)}A`;
  assert.throws(() => verifyProductMediaDeliveryToken(changed, config, now), /Invalid product media delivery token/);
  assert.throws(() => verifyProductMediaDeliveryToken(token, { ...config, signingKey: "different-signing-key-with-32-chars" }, now), /Invalid product media delivery token/);
});

test("rejects expired tokens", () => {
  const token = createProductMediaDeliveryToken(claims, config, now);
  assert.throws(() => verifyProductMediaDeliveryToken(token, config, now + 121_000), /expired/);
});

test("rejects excessive lifetime and malformed context claims", () => {
  assert.throws(
    () => createProductMediaDeliveryToken({ ...claims, expiresAt: Math.floor(now / 1000) + 301 }, config, now),
    /outside the permitted lifetime/
  );
  assert.throws(
    () => createProductMediaDeliveryToken({ ...claims, assetId: "../asset" }, config, now),
    /Invalid product media delivery token/
  );
});

test("requires a strong key and bounded lifetime", () => {
  assert.throws(() => createProductMediaDeliveryToken(claims, { ...config, signingKey: "too-short" }, now), /at least 32/);
  assert.throws(() => createProductMediaDeliveryToken(claims, { ...config, maximumLifetimeSeconds: 901 }, now), /between 1 and 900/);
  assert.throws(() => verifyProductMediaDeliveryToken("not-a-token", { ...config, signingKey: "short" }, now), /at least 32/);
});
