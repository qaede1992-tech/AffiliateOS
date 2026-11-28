import assert from "node:assert/strict";
import test from "node:test";
import { PreMediaEligibilityRefreshService } from "../src/domain/pre-media-eligibility-refresh.js";

const productId = "11111111-1111-4111-8111-111111111111";
const marketplaceId = "22222222-2222-4222-8222-222222222222";
const offerId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-11-28T10:00:00.000Z");
const candidate = {
  product: { id: productId, marketplaceId, status: "active" },
  offers: [{ id: offerId, productId, status: "active", affiliateLinkStatus: "active", affiliateUrl: "https://s.shopee.co.id/aff", commissionRateBps: 500 }]
};
const selected = { product: candidate.product, offerId, score: 78 };
const audit = { productId, marketplaceId, selected: true, score: 78, policy: {}, reasons: [] };

function setup(options: { latest?: any; decision?: any; selectedItems?: any[] } = {}) {
  const saved: any[] = [];
  let previews = 0;
  const service = new PreMediaEligibilityRefreshService(
    { async getCandidateByProductId(id: string) { assert.equal(id, productId); return candidate as any; } } as any,
    { async previewSelection(input: any) {
      previews++;
      assert.equal(input.disableAdaptiveExploration, true);
      assert.equal(input.feedbackHistoryMode, "latest");
      assert.equal(input.candidates.length, 1);
      assert.equal(input.candidates[0].product.id, productId);
      return { selected: options.selectedItems ?? [selected], rejected: [], audit: [options.decision ?? audit] };
    } } as any,
    { async listLatestByProduct() { return options.latest ? [options.latest] : []; }, async saveMany(rows: any[]) { saved.push(...rows); } },
    { minimumScore: 60, minimumDataConfidence: 35 },
    {},
    () => now
  );
  return { service, saved, previews: () => previews };
}

test("persists one evaluator-backed eligible record for one product with adaptive exploration disabled", async () => {
  const { service, saved, previews } = setup();
  const result = await service.refresh(productId);
  assert.equal(previews(), 1);
  assert.equal(saved.length, 1);
  assert.equal(result.evidence.eligible, true);
  assert.equal(result.evidence.offerId, offerId);
  assert.equal(result.evidence.score, 78);
  assert.equal(result.reused, false);
});

test("persists evaluator rejection and reasons rather than manufacturing eligibility", async () => {
  const rejection = { ...audit, selected: false, score: 22, reasons: ["Score below minimum"] };
  const { service, saved } = setup({ decision: rejection, selectedItems: [] });
  const result = await service.refresh(productId);
  assert.equal(saved.length, 1);
  assert.equal(result.evidence.eligible, false);
  assert.equal(result.evidence.score, 22);
  assert.deepEqual(result.evidence.reasons, ["Score below minimum"]);
  assert.equal(result.evidence.offerId, undefined);
});

test("reuses fresh evidence tied to the currently active offer without another evaluation or write", async () => {
  const latest = { id: "fresh", cycleId: "cycle", productId, marketplaceId, offerId, eligible: true, score: 78, policy: {}, reasons: [], createdAt: now.toISOString() };
  const { service, saved, previews } = setup({ latest });
  const result = await service.refresh(productId);
  assert.equal(result.reused, true);
  assert.equal(result.evidence.id, "fresh");
  assert.equal(previews(), 0);
  assert.equal(saved.length, 0);
});

test("rejects a missing active Shopee product without evaluating or writing evidence", async () => {
  const saved: any[] = [];
  const service = new PreMediaEligibilityRefreshService(
    { async getCandidateByProductId() { return undefined; } } as any,
    { async previewSelection() { throw new Error("must not evaluate"); } } as any,
    { async listLatestByProduct() { return []; }, async saveMany(rows: any[]) { saved.push(...rows); } }
  );
  await assert.rejects(() => service.refresh(productId), /Active Shopee affiliate-feed product/);
  assert.equal(saved.length, 0);
});
