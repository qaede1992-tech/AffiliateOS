import assert from "node:assert/strict";
import test from "node:test";
import type { AffiliateOffer, Product } from "@affiliateos/shared";
import type { PreMediaEligibilityEvidence, PreMediaEligibilityRepository } from "../../src/domain/pre-media-eligibility.js";
import {
  IllustrativeProductVideoPreviewError,
  IllustrativeProductVideoPreviewService
} from "../../src/domain/illustrative-product-video-preview.js";
import type { IllustrativeProductVideoRenderer } from "../../src/domain/illustrative-product-video-renderer.js";

const productId = "00000000-0000-4000-8000-000000000001";
const offerId = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-11-24T00:00:00.000Z");
const product = {
  id: productId, name: "Produk terpilih", status: "active", priceCents: 12500000, currency: "IDR"
} as Product;
const offer = {
  id: offerId, productId, affiliateAccountId: "affiliate-account",
  availability: "in_stock", availabilityMetadata: {}, affiliateLinkStatus: "active",
  status: "active", createdAt: now.toISOString(), updatedAt: now.toISOString()
} as AffiliateOffer;
const evidence = (overrides: Partial<PreMediaEligibilityEvidence> = {}): PreMediaEligibilityEvidence => ({
  id: "evidence-1", cycleId: "cycle-1", productId, marketplaceId: "marketplace-1",
  offerId, eligible: true, score: 85, policy: {}, reasons: [], createdAt: now.toISOString(),
  ...overrides
});
const output = {
  bytes: new Uint8Array([1, 2, 3]),
  metadata: {
    mimeType: "video/mp4" as const, width: 720 as const, height: 1280 as const,
    durationMs: 12_000 as const, fps: 25 as const, codec: "h264" as const,
    sha256: "a".repeat(64), byteSize: 3
  }
};

function createService(options: {
  rows?: PreMediaEligibilityEvidence[];
  productValue?: Product | undefined;
  offerValue?: AffiliateOffer | undefined;
} = {}) {
  let renderCalls = 0;
  let renderedInput: unknown;
  const renderer = {
    render: async (input: unknown) => {
      renderCalls += 1;
      renderedInput = input;
      return output;
    }
  } as unknown as IllustrativeProductVideoRenderer;
  const eligibility: PreMediaEligibilityRepository = {
    saveMany: async () => undefined,
    listLatestByProduct: async () => options.rows ?? [evidence()]
  };
  const service = new IllustrativeProductVideoPreviewService(
    { findById: async () => options.productValue === undefined ? product : options.productValue },
    { findById: async () => options.offerValue === undefined ? offer : options.offerValue },
    eligibility,
    renderer,
    () => now
  );
  return { service, get renderCalls() { return renderCalls; }, get renderedInput() { return renderedInput; } };
}

test("renders only after current pre-media evidence and an active affiliate offer pass", async () => {
  const harness = createService();
  const result = await harness.service.render(productId);
  assert.equal(result, output);
  assert.equal(harness.renderCalls, 1);
  assert.deepEqual(harness.renderedInput, {
    productName: product.name, priceCents: product.priceCents, currency: product.currency
  });
});

test("does not render when the latest evidence batch rejected the product", async () => {
  const harness = createService({
    rows: [
      evidence({ eligible: false, createdAt: now.toISOString() }),
      evidence({ id: "older", eligible: true, createdAt: "2026-11-23T00:00:00.000Z" })
    ]
  });
  await assert.rejects(
    harness.service.render(productId),
    (error: unknown) => error instanceof IllustrativeProductVideoPreviewError && error.code === "PRE_MEDIA_ELIGIBILITY_REQUIRED"
  );
  assert.equal(harness.renderCalls, 0);
});

test("does not render when the latest eligibility evidence is stale", async () => {
  const harness = createService({ rows: [evidence({ createdAt: "2026-11-01T00:00:00.000Z" })] });
  await assert.rejects(
    harness.service.render(productId),
    (error: unknown) => error instanceof IllustrativeProductVideoPreviewError && error.code === "PRE_MEDIA_ELIGIBILITY_STALE"
  );
  assert.equal(harness.renderCalls, 0);
});

test("does not render when the qualifying affiliate offer is no longer active", async () => {
  const harness = createService({ offerValue: { ...offer, affiliateLinkStatus: "expired" } });
  await assert.rejects(
    harness.service.render(productId),
    (error: unknown) => error instanceof IllustrativeProductVideoPreviewError && error.code === "AFFILIATE_OFFER_NOT_ACTIVE"
  );
  assert.equal(harness.renderCalls, 0);
});
