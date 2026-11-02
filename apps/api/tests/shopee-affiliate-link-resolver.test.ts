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

test("resolves Shopee's documented an_redir origin_link locally without fetching the product page", async () => {
  const productUrl = "https://shopee.co.id/product/305325624/29463945555?gads_t_sig=example";
  const affiliateUrl = "https://s.shopee.co.id/an_redir?origin_link=" + encodeURIComponent(productUrl) + "&affiliate_id=12345&sub_id=12345-test";
  let called = false;
  const fetcher = (async () => { called = true; return mockResponse("https://shopee.co.id/"); }) as typeof fetchPublicHttps;

  const result = await resolveShopeeAffiliateLink(affiliateUrl, {}, fetcher);

  assert.equal(called, false);
  assert.equal(result.status, "resolved");
  assert.equal(result.productUrl, productUrl);
  assert.equal(result.shopId, "305325624");
  assert.equal(result.itemId, "29463945555");
});

test("rejects an an_redir origin_link outside Shopee without fetching it", async () => {
  const affiliateUrl = "https://s.shopee.co.id/an_redir?origin_link=" + encodeURIComponent("https://example.com/product/1/2") + "&affiliate_id=12345";
  let called = false;
  const fetcher = (async () => { called = true; return mockResponse("https://shopee.co.id/"); }) as typeof fetchPublicHttps;

  const result = await resolveShopeeAffiliateLink(affiliateUrl, {}, fetcher);

  assert.equal(called, false);
  assert.equal(result.status, "unresolved");
  assert.match(result.reason ?? "", /valid HTTPS Shopee product URL/);
});

test("rejects credential-bearing Shopee an_redir origin links without fetching them", async () => {
  const origins = [
    "https://user@shopee.co.id/product/305325624/29463945555",
    "https://user:password@shopee.co.id/product/305325624/29463945555"
  ];
  for (const origin of origins) {
    const affiliateUrl = "https://s.shopee.co.id/an_redir?origin_link=" + encodeURIComponent(origin) + "&affiliate_id=12345";
    let called = false;
    const fetcher = (async () => { called = true; return mockResponse("https://shopee.co.id/"); }) as typeof fetchPublicHttps;
    const result = await resolveShopeeAffiliateLink(affiliateUrl, {}, fetcher);
    assert.equal(called, false);
    assert.equal(result.status, "unresolved");
    assert.match(result.reason ?? "", /valid HTTPS Shopee product URL/);
    assert.equal(result.productUrl, undefined);
  }
});

test("resolves a short affiliate link when redirects land directly on a Shopee product URL", async () => {
  let fetchOptions: Parameters<typeof fetchPublicHttps>[1] | undefined;
  const fetcher = (async (_url: string, options: Parameters<typeof fetchPublicHttps>[1]) => { fetchOptions = options; return mockResponse("https://shopee.co.id/product/305325624/29463945555"); }) as typeof fetchPublicHttps;
  const result = await resolveShopeeAffiliateLink("https://s.shopee.co.id/short", {}, fetcher);
  assert.deepEqual(fetchOptions?.allowedHosts, ["shopee.co.id", "shopee.com"]);
  assert.equal(result.status, "resolved");
  assert.equal(result.shopId, "305325624");
  assert.equal(result.itemId, "29463945555");
  assert.equal(result.productUrl, "https://shopee.co.id/product/305325624/29463945555");
});

test("resolves Shopee opaanlp redirect URLs to product identity", async () => {
  const landingUrl = "https://shopee.co.id/opaanlp/305325624/29463945555";
  const fetcher = (async () => mockResponse(landingUrl, "<html><body>Product page</body></html>")) as typeof fetchPublicHttps;
  const result = await resolveShopeeAffiliateLink("https://s.shopee.co.id/short", {}, fetcher);
  assert.equal(result.status, "resolved");
  assert.equal(result.landingUrl, landingUrl);
  assert.equal(result.productUrl, landingUrl);
  assert.equal(result.shopId, "305325624");
  assert.equal(result.itemId, "29463945555");
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
