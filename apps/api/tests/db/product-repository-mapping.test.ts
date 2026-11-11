import assert from "node:assert/strict";
import test from "node:test";
import { toProduct } from "../../src/db/repositories.js";

const baseRow = {
  id: "00000000-0000-4000-8000-000000000101",
  referenceNumber: 101,
  marketplaceId: "00000000-0000-4000-8000-000000000102",
  externalProductId: "shopee-101",
  name: "Product 101",
  description: null,
  category: null,
  priceCents: 10000,
  originalPriceCents: null,
  currency: "IDR",
  ratingMilli: null,
  reviewCount: 0,
  soldCount: 1000,
  imageUrl: null,
  videoUrl: null,
  productUrl: "https://shopee.co.id/product/1/101",
  status: "active",
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z"
};

test("preserves persisted discovery signals and metric provenance when hydrating products", () => {
  const discoverySignals = {
    audienceReachScore: 72,
    dataQuality: {
      soldCount: "lower_bound",
      reviewCount: "missing",
      ratingMilli: "missing",
      source: "shopee-affiliate-csv",
      capturedAt: "2026-11-07T00:00:00.000Z"
    }
  };

  const product = toProduct({ ...baseRow, discoverySignals } as any);

  assert.deepEqual(product.discoverySignals, discoverySignals);
  assert.equal(product.discoverySignals?.dataQuality?.reviewCount, "missing");
  assert.equal(product.discoverySignals?.dataQuality?.soldCount, "lower_bound");
});

test("omits discovery signals when the database column is null", () => {
  const product = toProduct({ ...baseRow, discoverySignals: null } as any);

  assert.equal(product.discoverySignals, undefined);
});
