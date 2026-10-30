import assert from "node:assert/strict";
import test from "node:test";
import { resolveShopeeAffiliateLink } from "../src/domain/shopee-affiliate-link-resolver.js";
import type { fetchPublicHttps } from "../src/domain/public-https-fetch.js";

const mockResponse = (url: string, html = "") => ({
  url,
  status: 200,
  headers: { "content-type": "text/html" },
  bytes: new TextEncoder().encode(html)
});

test("resolves a short affiliate link when redirects land directly on a Shopee product URL", async () => {
  const fetcher = (async () => mockResponse("https://shopee.co.id/product/305325624/29463945555")) as typeof fetchPublicHttps;
  const result = await resolveShopeeAffiliateLink("https://s.shopee.co.id/short", {}, fetcher);
  assert.equal(result.status, "resolved");
  assert.equal(result.shopId, "305325624");
  assert.equal(result.itemId, "29463945555");
  assert.equal(result.productUrl, "https://shopee.co.id/product/305325624/29463945555");
});

test("extracts canonical product URL from public Shopee HTML", async () => {
  const html = '<html><head><link rel="canonical" href="https://shopee.co.id/product/305325624/29463945555"><meta property="og:url" content="https://shopee.co.id/other"></head></html>';
  const fetcher = (async () => mockResponse("https://shopee.co.id/universal-link/abc", html)) as typeof fetchPublicHttps;
  const result = await resolveShopeeAffiliateLink("https://s.shopee.co.id/short", {}, fetcher);
  assert.equal(result.status, "resolved");
  assert.equal(result.shopId, "305325624");
  assert.equal(result.itemId, "29463945555");
});

test("returns a clear unresolved result when Shopee page does not expose product identity", async () => {
  const fetcher = (async () => mockResponse("https://shopee.co.id/universal-link/abc", "<html><body>Access denied</body></html>")) as typeof fetchPublicHttps;
  const result = await resolveShopeeAffiliateLink("https://s.shopee.co.id/short", {}, fetcher);
  assert.equal(result.status, "unresolved");
  assert.match(result.reason ?? "", /canonical product URL/);
});

test("rejects non-Shopee affiliate links without making a request", async () => {
  let called = false;
  const fetcher = (async () => { called = true; return mockResponse("https://shopee.co.id/product/1/2"); }) as typeof fetchPublicHttps;
  const result = await resolveShopeeAffiliateLink("https://example.com/affiliate", {}, fetcher);
  assert.equal(result.status, "unresolved");
  assert.equal(called, false);
});
