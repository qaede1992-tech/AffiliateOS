import assert from "node:assert/strict";
import test from "node:test";
import { normalizePublicApiBaseUrl, publicApiBaseUrlSchema } from "../../src/domain/public-api-base-url.js";

test("accepts and normalizes an explicit public HTTPS base URL", () => {
  assert.equal(normalizePublicApiBaseUrl("https://api.example.com/"), "https://api.example.com");
  assert.equal(normalizePublicApiBaseUrl("https://example.com/affiliateos/api/"), "https://example.com/affiliateos/api");
});

test("rejects HTTP and non-HTTP protocols", () => {
  assert.equal(publicApiBaseUrlSchema.safeParse("http://api.example.com").success, false);
  assert.equal(publicApiBaseUrlSchema.safeParse("ftp://api.example.com").success, false);
});

test("rejects credentials, query strings, and fragments", () => {
  for (const value of [
    "https://user:secret@api.example.com",
    "https://api.example.com?token=secret",
    "https://api.example.com#fragment"
  ]) {
    assert.equal(publicApiBaseUrlSchema.safeParse(value).success, false, value);
  }
});

test("rejects malformed and empty values", () => {
  for (const value of ["", "not-a-url", "/api", "https://"]) {
    assert.equal(publicApiBaseUrlSchema.safeParse(value).success, false, value);
  }
});
