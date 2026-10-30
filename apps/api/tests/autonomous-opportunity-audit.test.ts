import assert from "node:assert/strict";
import test from "node:test";
import type { AffiliateOffer, Product } from "@affiliateos/shared";
import { AutonomousOpportunitySelector } from "../src/domain/autonomous-opportunity.js";

const now = "2026-10-29T00:00:00.000Z";
const product: Product = {
  id: "product-1",
  marketplaceId: "marketplace-1",
  externalProductId: "external-1",
  name: "Kitchen storage organizer",
  description: "Useful kitchen storage",
  category: "kitchen",
  priceCents: 1000,
  currency: "IDR",
  ratingMilli: 4900,
  reviewCount: 500,
  soldCount: 2000,
  productUrl: "https://marketplace.example/product-1",
  status: "active",
  createdAt: now,
  updatedAt: now
};

const offer: AffiliateOffer = {
  id: "offer-1",
  productId: product.id,
  affiliateAccountId: "affiliate-account-1",
  commissionRateBps: 1000,
  commissionAmountCents: 100,
  availability: "in_stock",
  availabilityMetadata: {},
  affiliateUrl: "https://marketplace.example/affiliate-1",
  affiliateLinkStatus: "active",
  status: "active",
  createdAt: now,
  updatedAt: now
};

test("selection audit explains when publishable media is required but absent", () => {
  const result = new AutonomousOpportunitySelector().select(
    [{ product, offers: [offer] }],
    { minimumScore: 0, requirePublishableMedia: true }
  );

  assert.equal(result.selected.length, 0);
  assert.equal(result.audit.length, 1);
  assert.ok(
    result.audit[0]?.reasons.includes("Product has no HTTPS image or video suitable for autopublishing"),
    JSON.stringify(result.audit[0]?.reasons)
  );
});
