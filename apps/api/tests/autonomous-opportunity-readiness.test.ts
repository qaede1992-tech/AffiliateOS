import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousOpportunitySelector } from "../src/domain/autonomous-opportunity.js";

const product = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  marketplaceId: "shopee",
  externalProductId: id,
  name: "Example Product",
  description: "Example",
  category: "home",
  priceCents: 100000,
  currency: "IDR",
  reviewCount: 100,
  soldCount: 1000,
  productUrl: "https://shopee.co.id/product/example",
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides
}) as any;

const offer = (productId: string, overrides: Record<string, unknown> = {}) => ({
  id: `offer-${productId}`,
  productId,
  priceCents: 100000,
  currency: "IDR",
  commissionRateBps: 1300,
  availability: "in_stock",
  availabilityMetadata: {},
  affiliateUrl: "https://s.shopee.co.id/example",
  affiliateLinkStatus: "active",
  status: "active",
  ...overrides
}) as any;

test("autonomous selection rejects products without HTTPS media when publishable media is required", () => {
  const item = product("no-media");
  const result = new AutonomousOpportunitySelector().select(
    [{ product: item, offers: [offer(item.id)] }],
    { minimumScore: 0, requirePublishableMedia: true, maximumResults: 10 }
  );

  assert.equal(result.selected.length, 0);
  assert.match(result.rejected[0]?.reasons.join(" "), /no HTTPS image or video/i);
  assert.equal(result.audit[0]?.selected, false);
});

test("autonomous selection accepts an HTTPS image when publishable media is required", () => {
  const item = product("image");
  item.imageUrl = "https://cdn.example.test/product.jpg";
  const result = new AutonomousOpportunitySelector().select(
    [{ product: item, offers: [offer(item.id)] }],
    { minimumScore: 0, requirePublishableMedia: true, maximumResults: 10 }
  );

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0]?.offerId, `offer-${item.id}`);
});

test("autonomous selection rejects an offer without commission signal when required", () => {
  const item = product("no-commission", { imageUrl: "https://cdn.example.test/product.jpg" });
  const result = new AutonomousOpportunitySelector().select(
    [{ product: item, offers: [offer(item.id, { commissionRateBps: undefined, commissionAmountCents: undefined })] }],
    { minimumScore: 0, requirePublishableMedia: true, requireCommissionSignal: true, maximumResults: 10 }
  );

  assert.equal(result.selected.length, 0);
  assert.match(result.rejected[0]?.reasons.join(" "), /no commission rate or amount signal/i);
});
