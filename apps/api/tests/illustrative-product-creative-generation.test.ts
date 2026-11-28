import assert from "node:assert/strict";
import test from "node:test";
import type { AffiliateOffer, Product, Content } from "@affiliateos/shared";
import type { PreMediaEligibilityRepository } from "../src/domain/pre-media-eligibility.js";
import { IllustrativeProductCreativeGenerationService } from "../src/domain/illustrative-product-creative-generation.js";

const productId = "11111111-1111-4111-8111-111111111111";
const contentId = "22222222-2222-4222-8222-222222222222";
const offerId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-11-26T04:00:00.000Z");
const product = {
  id: productId, name: "Sample product", priceCents: 125000, currency: "IDR",
  status: "active"
} as Product;
const contentRecord = {
  id: contentId, productId, platform: "instagram",
  contentType: "affiliate-promotion", status: "draft"
} as Content;
const offer = {
  id: offerId, productId, status: "active", affiliateLinkStatus: "active",
  availability: "in_stock", affiliateLinkExpiresAt: undefined
} as AffiliateOffer;
const evidence = {
  id: "44444444-4444-4444-8444-444444444444", cycleId: "cycle-1",
  productId, marketplaceId: "55555555-5555-4555-8555-555555555555",
  offerId, eligible: true, score: 90, policy: {}, reasons: [],
  createdAt: now.toISOString()
};

function harness(options: { evidenceAt?: string; persistError?: Error } = {}) {
  const persisted: unknown[] = [];
  const removed: string[] = [];
  let renderCalls = 0;
  const eligibility = {
    async listLatestByProduct() {
      return [{ ...evidence, createdAt: options.evidenceAt ?? now.toISOString() }];
    }
  } as PreMediaEligibilityRepository;
  const service = new IllustrativeProductCreativeGenerationService({
    products: { async findById() { return product; } },
    contents: { async findById() { return contentRecord; } },
    offers: { async findById() { return offer; } },
    eligibility,
    creatives: {
      async createPending(input) {
        persisted.push(input);
        if (options.persistError) throw options.persistError;
        return {
          id: input.id, mediaAssetId: "66666666-6666-4666-8666-666666666666",
          contentId, productId, affiliateOfferId: offerId, platform: "instagram",
          sha256: input.sha256, mimeType: "video/mp4", byteSize: 128,
          disclosureEmbedded: true, reviewStatus: "pending", storageBackend: "local_volume",
          storageKey: input.storageKey
        };
      }
    },
    files: {
      async put(input: { creativeId: string; expectedSha256: string }) {
        return { key: input.creativeId + "-" + input.expectedSha256 + ".mp4", sha256: input.expectedSha256, byteSize: 128 };
      },
      async remove(key: string) { removed.push(key); }
    } as never,
    renderer: {
      async render() {
        renderCalls++;
        return { bytes: new Uint8Array([1, 2, 3]), metadata: {
          mimeType: "video/mp4" as const, width: 720 as const, height: 1280 as const,
          durationMs: 12000 as const, fps: 25 as const, codec: "h264" as const,
          sha256: "a".repeat(64), byteSize: 128
        } };
      }
    } as never,
    now: () => now
  });
  return { service, persisted, removed, get renderCalls() { return renderCalls; } };
}

test("generation persists a pending local-volume creative only for a freshly selected product and exact active offer", async () => {
  const h = harness();
  const result = await h.service.generate({ productId, contentId });
  assert.equal(result.reviewStatus, "pending");
  assert.equal(result.storageBackend, "local_volume");
  assert.equal(h.persisted.length, 1);
  const persisted = h.persisted[0] as { productSnapshot: Record<string, unknown> };
  assert.deepEqual(persisted.productSnapshot, {
    productId, name: product.name, priceCents: product.priceCents,
    currency: product.currency, capturedAt: now.toISOString()
  });
  assert.equal(h.renderCalls, 1);
  assert.deepEqual(h.removed, []);
});

test("generation rejects stale pre-media eligibility before rendering or writing a file", async () => {
  const h = harness({ evidenceAt: "2026-11-10T00:00:00.000Z" });
  await assert.rejects(() => h.service.generate({ productId, contentId }), /fresh non-media product eligibility/i);
  assert.equal(h.renderCalls, 0);
  assert.equal(h.persisted.length, 0);
  assert.deepEqual(h.removed, []);
});

test("generation removes the local file when the database transaction fails", async () => {
  const h = harness({ persistError: new Error("database write failed") });
  await assert.rejects(() => h.service.generate({ productId, contentId }), /database write failed/);
  assert.equal(h.persisted.length, 1);
  assert.equal(h.removed.length, 1);
  assert.match(h.removed[0]!, /\.mp4$/);
});
