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


test("stale resolving intake is reclaimed and resolved after an interrupted request", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const staleAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const intake = {
    id: "00000000-0000-4000-8000-000000000068",
    marketplaceSlug: "shopee-affiliate-feed" as const,
    affiliateUrl: "https://s.shopee.co.id/recover",
    normalizedUrlHash: "a".repeat(64),
    status: "resolving" as const,
    sourceMetadata: {},
    createdAt: staleAt,
    updatedAt: staleAt
  };
  await repository.saveIfAbsent(intake);
  let resolverCalls = 0;
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => {
    resolverCalls += 1;
    return { status: "unresolved", affiliateUrl, reason: "public page unavailable" };
  });

  const recovered = await service.submit(intake.affiliateUrl);
  assert.equal(resolverCalls, 1);
  assert.equal(recovered.status, "unresolved");
  assert.notEqual(recovered.updatedAt, staleAt);
});

test("stale resolving claim is compare-and-set so only one worker can recover it", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const staleAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const intake = {
    id: "00000000-0000-4000-8000-000000000069",
    marketplaceSlug: "shopee-affiliate-feed" as const,
    affiliateUrl: "https://s.shopee.co.id/concurrent-recover",
    normalizedUrlHash: "b".repeat(64),
    status: "resolving" as const,
    sourceMetadata: {},
    createdAt: staleAt,
    updatedAt: staleAt
  };
  await repository.saveIfAbsent(intake);
  const staleBefore = new Date(Date.now() - 60_000).toISOString();
  const claimedAt = new Date().toISOString();
  const claims = await Promise.all([
    repository.claimStaleResolving(intake.id, staleAt, staleBefore, claimedAt),
    repository.claimStaleResolving(intake.id, staleAt, staleBefore, claimedAt)
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
});


test("an expired worker cannot overwrite a newer worker's claimed intake", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const staleAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const intake = {
    id: "00000000-0000-4000-8000-000000000070",
    marketplaceSlug: "shopee-affiliate-feed" as const,
    affiliateUrl: "https://s.shopee.co.id/lease-guard",
    normalizedUrlHash: "c".repeat(64),
    status: "resolving" as const,
    sourceMetadata: {},
    createdAt: staleAt,
    updatedAt: staleAt
  };
  await repository.saveIfAbsent(intake);
  const claimedAt = new Date().toISOString();
  assert.equal(await repository.claimStaleResolving(intake.id, staleAt, new Date(Date.now() - 60_000).toISOString(), claimedAt), true);
  const staleCompletion = await repository.updateResolving({
    ...intake,
    status: "unresolved",
    reason: "late worker",
    updatedAt: new Date().toISOString()
  }, staleAt);
  assert.equal(staleCompletion, false);
  assert.equal((await repository.findById(intake.id))?.status, "resolving");
  assert.equal((await repository.findById(intake.id))?.updatedAt, claimedAt);
});
