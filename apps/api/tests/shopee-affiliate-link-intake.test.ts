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

test("Shopee link intake retries unresolved normalized URLs", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  let calls = 0;
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => { calls += 1; return { status: "unresolved", affiliateUrl, reason: "not publicly accessible" }; });
  const first = await service.submit("https://s.shopee.co.id/example#tracking");
  const second = await service.submit("https://s.shopee.co.id/example");
  assert.equal(first.id, second.id);
  assert.equal(calls, 2);
  assert.equal(second.status, "unresolved");
});


test("Shopee link intake recovers an unresolved URL on a later submission", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  let calls = 0;
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => {
    calls += 1;
    return calls === 1
      ? { status: "unresolved", affiliateUrl, reason: "temporary public page restriction" }
      : { status: "resolved", affiliateUrl, productUrl: "https://shopee.co.id/product/305325624/29463945555", shopId: "305325624", itemId: "29463945555" };
  });
  const first = await service.submit("https://s.shopee.co.id/retry-me");
  const retried = await service.submit("https://s.shopee.co.id/retry-me");
  assert.equal(first.id, retried.id);
  assert.equal(calls, 2);
  assert.equal(retried.status, "awaiting_offer_data");
  assert.equal(retried.shopId, "305325624");
  assert.equal(retried.itemId, "29463945555");
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
