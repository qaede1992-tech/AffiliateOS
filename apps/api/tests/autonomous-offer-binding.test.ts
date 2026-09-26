import assert from "node:assert/strict";
import test from "node:test";
import type { AffiliateOffer } from "@affiliateos/shared";
import { isExecutableAffiliateOffer } from "../src/domain/autonomous-opportunity.js";

const baseOffer: AffiliateOffer = {
  id: "00000000-0000-4000-8000-000000000101",
  productId: "00000000-0000-4000-8000-000000000201",
  conversionOfferId: "00000000-0000-4000-8000-000000000301",
  affiliateAccountId: "00000000-0000-4000-8000-000000000401",
  externalOfferId: "offer-101",
  priceCents: 10000,
  currency: "IDR",
  commissionRateBps: 1200,
  commissionAmountCents: 1200,
  availability: "in_stock",
  availabilityMetadata: {},
  affiliateUrl: "https://shopee.example.test/affiliate/offer-101",
  affiliateLinkStatus: "active",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

test("autonomous selection accepts only an active offer bound to the selected product", () => {
  assert.equal(isExecutableAffiliateOffer(baseOffer.productId, baseOffer), true);
  assert.equal(isExecutableAffiliateOffer("00000000-0000-4000-8000-000000000999", baseOffer), false);
});

test("autonomous selection rejects inactive, missing-link, invalid-link, and expired offers", () => {
  assert.equal(isExecutableAffiliateOffer(baseOffer.productId, { ...baseOffer, status: "inactive" }), false);
  assert.equal(isExecutableAffiliateOffer(baseOffer.productId, { ...baseOffer, affiliateLinkStatus: "not_generated", affiliateUrl: undefined }), false);
  assert.equal(isExecutableAffiliateOffer(baseOffer.productId, { ...baseOffer, affiliateUrl: "javascript:alert(1)" }), false);
  assert.equal(isExecutableAffiliateOffer(baseOffer.productId, { ...baseOffer, affiliateLinkExpiresAt: "2020-01-01T00:00:00.000Z" }), false);
});
