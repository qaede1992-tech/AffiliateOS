import assert from "node:assert/strict";
import test from "node:test";
import type { AffiliateOffer, Product } from "@affiliateos/shared";
import { scoreOpportunity } from "../../src/domain/opportunity-scoring.js";

const product: Product = {
  id: "eligibility-product",
  marketplaceId: "shopee",
  externalProductId: "sku-1",
  name: "Produk Uji",
  description: "Produk uji affiliate",
  category: "lifestyle",
  priceCents: 100000,
  currency: "IDR",
  ratingMilli: 4800,
  reviewCount: 500,
  soldCount: 2000,
  productUrl: "https://shopee.co.id/product/1",
  status: "active",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z"
};

const offer = (metadata: Record<string, unknown>): AffiliateOffer => ({
  id: "offer-1",
  productId: product.id,
  affiliateAccountId: "account-1",
  externalOfferId: "offer-1",
  priceCents: product.priceCents,
  currency: "IDR",
  commissionRateBps: 1000,
  commissionAmountCents: 10000,
  availability: "in_stock",
  availabilityMetadata: metadata,
  affiliateUrl: "https://s.shopee.co.id/example",
  affiliateLinkStatus: "active",
  status: "active",
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z"
});

test("opportunity scoring rejects an offer explicitly marked affiliate-ineligible", () => {
  const result = scoreOpportunity({
    product,
    offers: [offer({ affiliateEligible: false })]
  });

  assert.equal(result.offerId, undefined);
  assert.equal(result.breakdown.commission, 0);
  assert.ok(result.reasons.includes("No active affiliate offer available"));
});

test("opportunity scoring accepts an offer when eligibility is explicitly true", () => {
  const result = scoreOpportunity({
    product,
    offers: [offer({ affiliateEligible: true })]
  });

  assert.equal(result.offerId, "offer-1");
  assert.ok(result.breakdown.commission > 0);
});

test("opportunity scoring treats missing eligibility metadata as compatible for legacy feeds", () => {
  const result = scoreOpportunity({
    product,
    offers: [offer({ source: "legacy-feed" })]
  });

  assert.equal(result.offerId, "offer-1");
});