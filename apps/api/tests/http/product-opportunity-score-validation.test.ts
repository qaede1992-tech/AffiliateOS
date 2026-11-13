import assert from "node:assert/strict";
import test from "node:test";
import { scoreProductSchema } from "../../src/http/validation.js";

const product = {
  id: "33333333-3333-4333-8333-333333333333",
  marketplaceId: "44444444-4444-4444-8444-444444444444",
  externalProductId: "test-product-1",
  name: "Timestamp compatibility test",
  priceCents: 10000,
  currency: "IDR",
  reviewCount: 0,
  soldCount: 0,
  productUrl: "https://example.test/products/1",
  status: "active" as const,
  createdAt: "2026-10-30 04:15:51.205+00",
  updatedAt: "2026-10-30 11:15:51.205+07"
};

test("product scoring accepts and normalizes PostgreSQL timestamptz text", () => {
  const parsed = scoreProductSchema.parse({ product });
  assert.equal(parsed.product.createdAt, "2026-10-30T04:15:51.205Z");
  assert.equal(parsed.product.updatedAt, "2026-10-30T04:15:51.205Z");
});

test("product scoring continues to accept strict ISO timestamps", () => {
  const parsed = scoreProductSchema.parse({
    product: {
      ...product,
      createdAt: "2026-10-30T04:15:51.205Z",
      updatedAt: "2026-10-30T04:15:51.205Z"
    }
  });
  assert.equal(parsed.product.createdAt, "2026-10-30T04:15:51.205Z");
});

test("product scoring rejects invalid timestamp strings", () => {
  assert.throws(() => scoreProductSchema.parse({
    product: { ...product, createdAt: "not-a-timestamp" }
  }));
});

test("product scoring rejects impossible calendar dates after PostgreSQL timestamp normalization", () => {
  assert.throws(() => scoreProductSchema.parse({
    product: { ...product, createdAt: "2026-02-30 04:15:51.205+00" }
  }));
});

test("product scoring normalizes nullable PostgreSQL product columns to undefined", () => {
  const parsed = scoreProductSchema.parse({
    product: {
      ...product,
      description: null,
      category: null,
      originalPriceCents: null,
      ratingMilli: null,
      imageUrl: null
    }
  });
  assert.equal(parsed.product.description, undefined);
  assert.equal(parsed.product.category, undefined);
  assert.equal(parsed.product.originalPriceCents, undefined);
  assert.equal(parsed.product.ratingMilli, undefined);
  assert.equal(parsed.product.imageUrl, undefined);
});
