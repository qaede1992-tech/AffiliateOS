import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryShopeeAffiliateLinkIntakeRepository } from "../src/domain/repository.js";
import { ShopeeAffiliateLinkIntakeService } from "../src/domain/shopee-affiliate-link-intake.js";

test("Shopee link intake persists resolved product identity and awaits verified offer data", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => ({ status: "resolved", affiliateUrl, productUrl: "https://shopee.co.id/product/123/456", shopId: "123", itemId: "456" }));
  const intake = await service.submit("https://s.shopee.co.id/example");
  assert.equal(intake.status, "awaiting_offer_data");
  assert.equal(intake.shopId, "123");
  assert.equal(intake.itemId, "456");
  assert.equal((await service.get(intake.id))?.id, intake.id);
});

test("Shopee link intake is idempotent for normalized URLs", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  let calls = 0;
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => { calls += 1; return { status: "unresolved", affiliateUrl, reason: "not publicly accessible" }; });
  const first = await service.submit("https://s.shopee.co.id/example#tracking");
  const second = await service.submit("https://s.shopee.co.id/example");
  assert.equal(first.id, second.id);
  assert.equal(calls, 1);
  assert.equal(second.status, "unresolved");
});

test("different affiliate URLs resolving to the same Shopee product deduplicate by product identity", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => ({
    status: "resolved", affiliateUrl, productUrl: "https://shopee.co.id/product/123/456", shopId: "123", itemId: "456"
  }));
  const first = await service.submit("https://s.shopee.co.id/first");
  const second = await service.submit("https://s.shopee.co.id/second");
  assert.equal(first.id, second.id);
});

test("verified feed offer reconciles a matching intake without inventing offer values", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => ({
    status: "resolved", affiliateUrl, productUrl: "https://shopee.co.id/product/123/456", shopId: "123", itemId: "456"
  }));
  const intake = await service.submit("https://s.shopee.co.id/short");
  assert.equal(intake.status, "awaiting_offer_data");
  const reconciled = await service.reconcileVerifiedOffer("https://shopee.co.id/product/123/456");
  assert.equal(reconciled?.status, "imported");
  assert.equal(reconciled?.sourceMetadata.verifiedOfferSource, "shopee-affiliate-feed");
});


test("duplicate product URL finalizes the second intake instead of leaving an orphan resolving row", async () => {
  class TrackingRepository extends InMemoryShopeeAffiliateLinkIntakeRepository {
    createdIds: string[] = [];
    override async saveIfAbsent(intake: import("../src/domain/shopee-affiliate-link-intake.js").ShopeeAffiliateLinkIntake) {
      const saved = await super.saveIfAbsent(intake);
      this.createdIds.push(saved.id);
      return saved;
    }
  }
  const repository = new TrackingRepository();
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => ({
    status: "resolved", affiliateUrl, productUrl: "https://shopee.co.id/product/123/456", shopId: "123", itemId: "456"
  }));

  const first = await service.submit("https://s.shopee.co.id/first");
  const second = await service.submit("https://s.shopee.co.id/second");
  const duplicateRecordId = repository.createdIds[1];
  assert.ok(duplicateRecordId);
  assert.equal(second.id, first.id, "the canonical intake remains the returned result");
  const duplicateRecord = await service.get(duplicateRecordId);
  assert.equal(duplicateRecord?.status, "resolved");
  assert.equal(duplicateRecord?.sourceMetadata.duplicateOfIntakeId, first.id);
  assert.notEqual(duplicateRecord?.status, "resolving");
});
