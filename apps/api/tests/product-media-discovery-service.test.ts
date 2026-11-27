import assert from "node:assert/strict";
import test from "node:test";
import type { AffiliateOffer, Product } from "@affiliateos/shared";
import { ProductMediaDiscoveryError, ProductMediaDiscoveryService } from "../src/domain/product-media-discovery-service.js";

const product = {
  id: "33333333-3333-4333-8333-333333333333",
  status: "active",
  marketplaceId: "shopee-market",
  productUrl: "https://shopee.co.id/product/123/456"
} as unknown as Product;
const offer = {
  id: "44444444-4444-4444-8444-444444444444",
  productId: product.id,
  status: "active",
  affiliateLinkStatus: "active",
  affiliateUrl: "https://s.shopee.co.id/affiliate",
  affiliateLinkExpiresAt: null,
  availabilityMetadata: {}
} as unknown as AffiliateOffer;
const now = new Date("2026-11-28T00:00:00.000Z");
const freshEvidence = {
  id: "evidence-1",
  cycleId: "cycle-1",
  productId: product.id,
  marketplaceId: product.marketplaceId,
  offerId: offer.id,
  eligible: true,
  score: 90,
  policy: {},
  reasons: [],
  createdAt: now.toISOString()
};

function makeService(options: {
  evidence?: typeof freshEvidence | null;
  offer?: AffiliateOffer;
  product?: Product;
} = {}) {
  let calls = 0;
  const service = new ProductMediaDiscoveryService({
    runner: {
      async discover(selectedProduct, eligibilityPassed) {
        calls += 1;
        assert.equal(selectedProduct.id, product.id);
        assert.equal(eligibilityPassed, true);
        return { productId: product.id, pageFetched: false, hasVideo: false, stored: [], skipped: [] };
      }
    },
    preMediaEligibility: {
      async listLatestByProduct() {
        if (options.evidence === null) return [];
        return [options.evidence ?? freshEvidence];
      }
    },
    findProductById: async () => options.product ?? product,
    findAffiliateOfferById: async () => options.offer ?? offer,
    now: () => now
  });
  return { service, calls: () => calls };
}

test("discovers one active Shopee product only after matching fresh eligibility and offer validation", async () => {
  const { service, calls } = makeService();
  const result = await service.discoverShopeeProductMedia(product.id);
  assert.equal(calls(), 1);
  assert.equal(result.productId, product.id);
});

test("fails closed when persisted eligibility evidence is missing", async () => {
  const { service, calls } = makeService({ evidence: null });
  await assert.rejects(() => service.discoverShopeeProductMedia(product.id), (error: unknown) =>
    error instanceof ProductMediaDiscoveryError && error.code === "PRODUCT_MEDIA_DISCOVERY_ELIGIBILITY_REQUIRED");
  assert.equal(calls(), 0);
});

test("rejects stale evidence and an affiliate offer belonging to another product", async () => {
  const stale = { ...freshEvidence, createdAt: "2026-11-26T00:00:00.000Z" };
  const staleService = makeService({ evidence: stale });
  await assert.rejects(() => staleService.service.discoverShopeeProductMedia(product.id), (error: unknown) =>
    error instanceof ProductMediaDiscoveryError && error.code === "PRODUCT_MEDIA_DISCOVERY_ELIGIBILITY_REQUIRED");
  const wrongOffer = makeService({ offer: { ...offer, productId: "another-product" } as AffiliateOffer });
  await assert.rejects(() => wrongOffer.service.discoverShopeeProductMedia(product.id), (error: unknown) =>
    error instanceof ProductMediaDiscoveryError && error.code === "PRODUCT_MEDIA_DISCOVERY_OFFER_UNAVAILABLE");
  assert.equal(wrongOffer.calls(), 0);
});

test("rejects non-Shopee URLs before invoking media providers", async () => {
  const { service, calls } = makeService({ product: { ...product, productUrl: "https://example.com/item" } as Product });
  await assert.rejects(() => service.discoverShopeeProductMedia(product.id), (error: unknown) =>
    error instanceof ProductMediaDiscoveryError && error.code === "PRODUCT_MEDIA_DISCOVERY_NOT_SHOPEE");
  assert.equal(calls(), 0);
});
