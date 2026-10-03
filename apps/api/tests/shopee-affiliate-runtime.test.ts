import assert from "node:assert/strict";
import test from "node:test";
import { createShopeeAffiliateProvider } from "../src/domain/shopee-affiliate-runtime.js";

test("Shopee runtime remains disabled when no credential reference is configured", () => {
  assert.equal(createShopeeAffiliateProvider({ market: "ID", apiVersion: "v2" }), undefined);
});

test("Shopee runtime remains disabled under the current unsupported access model", () => {
  const provider = createShopeeAffiliateProvider({
    credentialReference: "secret://affiliateos/shopee/production",
    market: "ID",
    apiVersion: "v2"
  });
  assert.equal(provider, undefined);
});

test("Shopee runtime rejects unsafe credential references before activation", () => {
  assert.throws(
    () =>
      createShopeeAffiliateProvider({
        credentialReference: "secret value",
        market: "ID",
        apiVersion: "v2"
      }),
    /opaque secret-manager reference/
  );
});
