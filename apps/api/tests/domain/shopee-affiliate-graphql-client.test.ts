import assert from "node:assert/strict";
import test from "node:test";
import { ShopeeAffiliateGraphqlClient } from "../../src/domain/shopee-affiliate-graphql-client.js";

const fetchImpl = async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify({
  data: {
    productOfferV2: {
      nodes: [{
        itemId: "123456789",
        productName: "Test product",
        productLink: "https://shopee.co.id/product/123",
        priceMin: "10000",
        commissionRate: "0.05",
        sales: 42
      }],
      pageInfo: { page: 1, limit: 1, hasNextPage: false }
    }
  }
}), { status: 200, headers: { "content-type": "application/json" } });

const credentials = { appId: "test-app", secret: "test-secret" };

test("Shopee client rejects unsupported markets instead of constructing arbitrary endpoints", () => {
  assert.throws(
    () => new ShopeeAffiliateGraphqlClient({ market: "XX", credentials, fetchImpl }),
    /Unsupported Shopee Affiliate market: XX/
  );
});

test("Shopee client rejects non-numeric product ids before making a request", async () => {
  const client = new ShopeeAffiliateGraphqlClient({ market: "ID", credentials, fetchImpl });
  await assert.rejects(() => client.getProduct("product-123"), /Shopee product ID must be a safe integer/);
  await assert.rejects(() => client.getOffers("12.5"), /Shopee product ID must be a safe integer/);
});

test("Shopee client rejects unsafe integer product ids", async () => {
  const client = new ShopeeAffiliateGraphqlClient({ market: "ID", credentials, fetchImpl });
  await assert.rejects(() => client.getProduct("9007199254740992"), /Shopee product ID must be a safe integer/);
});

test("Shopee client accepts a safe numeric product id", async () => {
  const client = new ShopeeAffiliateGraphqlClient({ market: "ID", credentials, fetchImpl });
  const product = await client.getProduct("123456789");
  assert.equal(product?.externalProductId, "123456789");
  assert.equal(product?.name, "Test product");
});
