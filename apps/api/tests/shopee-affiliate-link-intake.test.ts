import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApp } from "../src/app.js";
import type { Services } from "../src/domain/container.js";
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

test("Shopee link intake is idempotent for normalized URLs after a successful resolution", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  let calls = 0;
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => {
    calls += 1;
    return { status: "resolved", affiliateUrl, productUrl: "https://shopee.co.id/product/123/456", shopId: "123", itemId: "456" };
  });
  const first = await service.submit("https://s.shopee.co.id/example#tracking");
  const second = await service.submit("https://s.shopee.co.id/example");
  assert.equal(first.id, second.id);
  assert.equal(calls, 1);
  assert.equal(second.status, "awaiting_offer_data");
});

test("stale legacy resolving intake is retried in place after the recovery window", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const url = "https://s.shopee.co.id/legacy-stuck";
  const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const intake = {
    id: "legacy-stuck-intake",
    marketplaceSlug: "shopee-affiliate-feed" as const,
    affiliateUrl: url,
    normalizedUrlHash: createHash("sha256").update(url).digest("hex"),
    status: "resolving" as const,
    sourceMetadata: {},
    createdAt: staleAt,
    updatedAt: staleAt
  };
  await repository.saveIfAbsent(intake);
  let calls = 0;
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => {
    calls += 1;
    return { status: "resolved", affiliateUrl, productUrl: "https://shopee.co.id/product/123/456", shopId: "123", itemId: "456" };
  });

  const recovered = await service.submit(url);

  assert.equal(calls, 1);
  assert.equal(recovered.id, intake.id);
  assert.equal(recovered.status, "awaiting_offer_data");
  assert.equal(recovered.shopId, "123");
  assert.equal(recovered.itemId, "456");
  assert.equal((await repository.findById(intake.id))?.sourceMetadata.recoveredFromStaleResolving, true);
});

test("fresh resolving intake is not fetched again while another request may still own it", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const url = "https://s.shopee.co.id/active-resolution";
  const now = new Date().toISOString();
  const intake = {
    id: "active-resolution-intake",
    marketplaceSlug: "shopee-affiliate-feed" as const,
    affiliateUrl: url,
    normalizedUrlHash: createHash("sha256").update(url).digest("hex"),
    status: "resolving" as const,
    sourceMetadata: {},
    createdAt: now,
    updatedAt: now
  };
  await repository.saveIfAbsent(intake);
  let calls = 0;
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => {
    calls += 1;
    return { status: "unresolved", affiliateUrl, reason: "should not be called" };
  });

  const result = await service.submit(url);

  assert.equal(calls, 0);
  assert.equal(result.status, "resolving");
});

test("stale resolving claim is compare-and-set guarded", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const url = "https://s.shopee.co.id/claim-once";
  const now = new Date(Date.now() - 10 * 60_000).toISOString();
  const intake = {
    id: "claim-once-intake",
    marketplaceSlug: "shopee-affiliate-feed" as const,
    affiliateUrl: url,
    normalizedUrlHash: createHash("sha256").update(url).digest("hex"),
    status: "resolving" as const,
    sourceMetadata: {},
    createdAt: now,
    updatedAt: now
  };
  await repository.saveIfAbsent(intake);

  assert.equal(await repository.claimStaleResolving(intake.id, now, new Date().toISOString()), true);
  assert.equal(await repository.claimStaleResolving(intake.id, now, new Date().toISOString()), false);
});

test("different affiliate URLs resolving to the same Shopee product deduplicate by product identity", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => ({
    status: "resolved", affiliateUrl, productUrl: "https://shopee.co.id/product/123/456", shopId: "123", itemId: "456"
  }));
  const first = await service.submit("https://s.shopee.co.id/first");
  const secondUrl = "https://s.shopee.co.id/second";
  const second = await service.submit(secondUrl);
  assert.equal(first.id, second.id);
  const secondHash = createHash("sha256").update(secondUrl).digest("hex");
  assert.equal(await repository.findByUrlHash(secondHash), undefined, "Duplicate product identity must not leave an orphan resolving intake.");
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

test("intake repository resolves product-identity conflicts to the existing row", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const now = "2026-10-30T00:00:00.000Z";
  const makeIntake = (id: string, url: string) => ({
    id,
    marketplaceSlug: "shopee-affiliate-feed" as const,
    affiliateUrl: url,
    normalizedUrlHash: createHash("sha256").update(url).digest("hex"),
    shopId: "123",
    itemId: "456",
    status: "awaiting_offer_data" as const,
    sourceMetadata: { resolution: "resolved" },
    createdAt: now,
    updatedAt: now
  });
  const first = await repository.saveIfAbsent(makeIntake("intake-1", "https://s.shopee.co.id/first"));
  const duplicate = await repository.saveIfAbsent(makeIntake("intake-2", "https://s.shopee.co.id/second"));
  assert.equal(duplicate.id, first.id);
  assert.equal(await repository.findByUrlHash(createHash("sha256").update("https://s.shopee.co.id/second").digest("hex")), undefined);
});

test("Shopee intake lookup requires an operator role", async () => {
  const intakeId = "11111111-1111-4111-8111-111111111111";
  let lookupCalled = false;
  const services = {
    shopeeAffiliateLinkIntakes: {
      get: async (id: string) => {
        lookupCalled = true;
        assert.equal(id, intakeId);
        return undefined;
      }
    }
  } as unknown as Services;
  const app = createApp(services, {
    auth: { enabled: false, operatorId: "viewer", role: "viewer" },
    rateLimit: { enabled: false, limit: 100, windowMs: 60_000 }
  });

  const response = await app.inject({
    method: "GET",
    url: `/api/v1/shopee/affiliate-link-intakes/${intakeId}`
  });

  assert.equal(response.statusCode, 403);
  assert.equal(lookupCalled, false);
  await app.close();
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
