import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApp } from "../src/app.js";
import type { Services } from "../src/domain/container.js";
import { InMemoryShopeeAffiliateLinkIntakeRepository } from "../src/domain/repository.js";
import { ShopeeAffiliateLinkIntakeService, type ShopeeAffiliateLinkIntake, type ShopeeAffiliateLinkIntakeRepository } from "../src/domain/shopee-affiliate-link-intake.js";

test("documented Shopee an_redir link flows through intake to verified product identity without page fetch", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const service = new ShopeeAffiliateLinkIntakeService(repository);
  const productUrl = "https://shopee.co.id/product/305325624/29463945555?gads_t_sig=example";
  const affiliateUrl = "https://s.shopee.co.id/an_redir?origin_link=" +
    encodeURIComponent(productUrl) + "&affiliate_id=12345&sub_id=affiliateos-test";

  const intake = await service.submit(affiliateUrl);

  assert.equal(intake.status, "awaiting_offer_data");
  assert.equal(intake.canonicalProductUrl, productUrl);
  assert.equal(intake.shopId, "305325624");
  assert.equal(intake.itemId, "29463945555");
  assert.equal(intake.affiliateUrl, affiliateUrl);
  assert.equal(intake.sourceMetadata.resolution, "resolved");
  assert.equal((await service.get(intake.id))?.canonicalProductUrl, productUrl);
});

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

test("different affiliate URLs resolving to the same Shopee product deduplicate without persisting a duplicate intake", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => ({
    status: "resolved", affiliateUrl, productUrl: "https://shopee.co.id/product/123/456", shopId: "123", itemId: "456"
  }));
  const first = await service.submit("https://s.shopee.co.id/first");
  const secondUrl = "https://s.shopee.co.id/second";
  const second = await service.submit(secondUrl);
  assert.equal(first.id, second.id);
  const secondHash = createHash("sha256").update(secondUrl).digest("hex");
  assert.equal(await repository.findByUrlHash(secondHash), undefined);
});

test("concurrent affiliate URLs resolving to the same Shopee product persist only one intake", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  let resolverCalls = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => {
    resolverCalls += 1;
    if (resolverCalls === 2) release();
    await barrier;
    return { status: "resolved", affiliateUrl, productUrl: "https://shopee.co.id/product/123/456", shopId: "123", itemId: "456" };
  });
  const urls = ["https://s.shopee.co.id/race-first", "https://s.shopee.co.id/race-second"];
  const [first, second] = await Promise.all(urls.map((url) => service.submit(url)));
  assert.equal(resolverCalls, 2);
  assert.equal(first.id, second.id);
  const hashes = urls.map((url) => createHash("sha256").update(url).digest("hex"));
  const stored = await Promise.all(hashes.map((hash) => repository.findByUrlHash(hash)));
  assert.equal(stored.filter(Boolean).length, 1);
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


test("stale resolver cannot complete after a newer resolver has reclaimed the intake", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const url = "https://s.shopee.co.id/lease-fencing";
  const originalAt = "2026-10-01T00:00:00.000Z";
  const firstClaimAt = "2026-10-01T00:06:00.000Z";
  const secondClaimAt = "2026-10-01T00:12:00.000Z";
  const intake = {
    id: "lease-fencing-intake", marketplaceSlug: "shopee-affiliate-feed" as const,
    affiliateUrl: url, normalizedUrlHash: createHash("sha256").update(url).digest("hex"),
    status: "resolving" as const, sourceMetadata: {}, createdAt: originalAt, updatedAt: originalAt
  };
  await repository.saveIfAbsent(intake);
  assert.equal(await repository.claimStaleResolving(intake.id, originalAt, firstClaimAt), true);
  assert.equal(await repository.claimStaleResolving(intake.id, firstClaimAt, secondClaimAt), true);

  const staleCompletion = await repository.updateIfResolving(intake.id, firstClaimAt, {
    ...intake, status: "unresolved", reason: "late resolver", updatedAt: "2026-10-01T00:13:00.000Z"
  });
  assert.equal(staleCompletion, undefined);

  const currentCompletion = await repository.updateIfResolving(intake.id, secondClaimAt, {
    ...intake, status: "awaiting_offer_data", shopId: "123", itemId: "456",
    updatedAt: "2026-10-01T00:14:00.000Z"
  });
  assert.equal(currentCompletion?.status, "awaiting_offer_data");
  assert.equal(currentCompletion?.shopId, "123");
});

test("scheduled stale intake recovery processes a bounded batch and ignores fresh rows", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const freshAt = new Date().toISOString();
  const makeIntake = (id: string, updatedAt: string) => ({
    id, marketplaceSlug: "shopee-affiliate-feed" as const,
    affiliateUrl: `https://s.shopee.co.id/${id}`,
    normalizedUrlHash: createHash("sha256").update(id).digest("hex"),
    status: "resolving" as const, sourceMetadata: {}, createdAt: updatedAt, updatedAt
  });
  await repository.saveIfAbsent(makeIntake("stale-a", staleAt));
  await repository.saveIfAbsent(makeIntake("stale-b", staleAt));
  await repository.saveIfAbsent(makeIntake("fresh", freshAt));
  let calls = 0;
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (affiliateUrl) => {
    calls += 1;
    return { status: "unresolved", affiliateUrl, reason: "temporary restriction" };
  });

  const result = await service.recoverStaleResolvingBatch({ batchSize: 2, concurrency: 2, resolverTimeoutMs: 1_000 });
  assert.deepEqual(result, { scanned: 2, recovered: 2, failed: 2, skipped: 0 });
  assert.equal(calls, 2);
  assert.equal((await repository.findByUrlHash(createHash("sha256").update("fresh").digest("hex")))?.status, "resolving");
});

test("parallel recovery workers use compare-and-set so only one resolver runs per intake", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const url = "https://s.shopee.co.id/recovery-race";
  const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
  await repository.saveIfAbsent({
    id: "recovery-race", marketplaceSlug: "shopee-affiliate-feed", affiliateUrl: url,
    normalizedUrlHash: createHash("sha256").update(url).digest("hex"),
    status: "resolving", sourceMetadata: {}, createdAt: staleAt, updatedAt: staleAt
  });
  let calls = 0;
  const resolver = async (affiliateUrl: string) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { status: "unresolved" as const, affiliateUrl, reason: "no product identity" };
  };
  const first = new ShopeeAffiliateLinkIntakeService(repository, resolver);
  const second = new ShopeeAffiliateLinkIntakeService(repository, resolver);
  const results = await Promise.all([
    first.recoverStaleResolvingBatch({ batchSize: 10, concurrency: 1, resolverTimeoutMs: 1_000 }),
    second.recoverStaleResolvingBatch({ batchSize: 10, concurrency: 1, resolverTimeoutMs: 1_000 })
  ]);
  assert.equal(calls, 1);
  assert.equal(results.reduce((sum, result) => sum + result.recovered, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.skipped, 0), 1);
});

test("recovery metrics do not double-count an intake completed by another worker", async () => {
  const baseRepository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const url = "https://s.shopee.co.id/recovery-metrics-race";
  const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const intake: ShopeeAffiliateLinkIntake = {
    id: "recovery-metrics-race",
    marketplaceSlug: "shopee-affiliate-feed" as const,
    affiliateUrl: url,
    normalizedUrlHash: createHash("sha256").update(url).digest("hex"),
    status: "resolving" as const,
    sourceMetadata: {},
    createdAt: staleAt,
    updatedAt: staleAt
  };
  await baseRepository.saveIfAbsent(intake);
  const repository: ShopeeAffiliateLinkIntakeRepository = {
    findByUrlHash: (hash: string) => baseRepository.findByUrlHash(hash),
    findByProductIdentity: (shopId: string, itemId: string) => baseRepository.findByProductIdentity(shopId, itemId),
    findById: (id: string) => baseRepository.findById(id),
    saveIfAbsent: (value: ShopeeAffiliateLinkIntake) => baseRepository.saveIfAbsent(value),
    update: (value: ShopeeAffiliateLinkIntake) => baseRepository.update(value),
    // Both workers retain the same stale snapshot; the second sees the first worker's completed row.
    listStaleResolving: async () => [intake],
    nextStaleResolvingAt: () => baseRepository.nextStaleResolvingAt(),
    claimStaleResolving: (id: string, expectedUpdatedAt: string, claimedAt: string) =>
      baseRepository.claimStaleResolving(id, expectedUpdatedAt, claimedAt),
    updateIfResolving: (id: string, expectedUpdatedAt: string, value: ShopeeAffiliateLinkIntake) =>
      baseRepository.updateIfResolving(id, expectedUpdatedAt, value)
  };
  let resolverCalls = 0;
  const resolver = async (affiliateUrl: string) => {
    resolverCalls += 1;
    return { status: "unresolved" as const, affiliateUrl, reason: "temporary restriction" };
  };
  const first = new ShopeeAffiliateLinkIntakeService(repository, resolver);
  const second = new ShopeeAffiliateLinkIntakeService(repository, resolver);
  const options = { batchSize: 1, concurrency: 1, resolverTimeoutMs: 1_000 };

  const firstResult = await first.recoverStaleResolvingBatch(options);
  const secondResult = await second.recoverStaleResolvingBatch(options);

  assert.deepEqual(firstResult, { scanned: 1, recovered: 1, failed: 1, skipped: 0 });
  assert.deepEqual(secondResult, { scanned: 1, recovered: 0, failed: 0, skipped: 1 });
  assert.equal(resolverCalls, 1);
});

test("resolver timeout marks stale intake unresolved and late completion cannot overwrite it", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const url = "https://s.shopee.co.id/recovery-timeout";
  const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
  await repository.saveIfAbsent({
    id: "recovery-timeout", marketplaceSlug: "shopee-affiliate-feed", affiliateUrl: url,
    normalizedUrlHash: createHash("sha256").update(url).digest("hex"),
    status: "resolving", sourceMetadata: {}, createdAt: staleAt, updatedAt: staleAt
  });
  let releaseResolver!: (value: { status: "resolved"; affiliateUrl: string; productUrl: string; shopId: string; itemId: string }) => void;
  const resolverPromise = new Promise<{ status: "resolved"; affiliateUrl: string; productUrl: string; shopId: string; itemId: string }>((resolve) => { releaseResolver = resolve; });
  const service = new ShopeeAffiliateLinkIntakeService(repository, () => resolverPromise);
  const result = await service.recoverStaleResolvingBatch({ batchSize: 1, concurrency: 1, resolverTimeoutMs: 1_000 });
  assert.equal(result.failed, 1);
  const afterTimeout = await repository.findByUrlHash(createHash("sha256").update(url).digest("hex"));
  assert.equal(afterTimeout?.status, "unresolved");
  assert.match(afterTimeout?.reason ?? "", /timed out/i);

  releaseResolver({ status: "resolved", affiliateUrl: url, productUrl: "https://shopee.co.id/product/123/456", shopId: "123", itemId: "456" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterLateCompletion = await repository.findByUrlHash(createHash("sha256").update(url).digest("hex"));
  assert.equal(afterLateCompletion?.status, "unresolved");
});

test("Shopee intake repository returns only the earliest resolving recovery deadline", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const base = new Date("2026-11-13T10:00:00.000Z");
  const resolving = {
    id: "intake-resolving",
    marketplaceSlug: "shopee-affiliate-feed" as const,
    affiliateUrl: "https://s.shopee.co.id/resolving",
    normalizedUrlHash: "resolving-hash",
    status: "resolving" as const,
    sourceMetadata: {},
    createdAt: base.toISOString(),
    updatedAt: base.toISOString()
  };
  await repository.saveIfAbsent(resolving);
  await repository.saveIfAbsent({
    ...resolving,
    id: "intake-complete",
    affiliateUrl: "https://s.shopee.co.id/complete",
    normalizedUrlHash: "complete-hash",
    status: "awaiting_offer_data",
    updatedAt: new Date(base.getTime() - 60_000).toISOString()
  });

  assert.equal(
    await repository.nextStaleResolvingAt(),
    new Date(base.getTime() + 5 * 60_000).toISOString()
  );
});

test("new Shopee intake resolves inline without scheduling a stale-row recovery job", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  let resolve!: (value: { status: "resolved"; affiliateUrl: string; productUrl: string; shopId: string; itemId: string }) => void;
  const resolution = new Promise<{ status: "resolved"; affiliateUrl: string; productUrl: string; shopId: string; itemId: string }>((yes) => { resolve = yes; });
  let wakeSignals = 0;
  const affiliateUrl = "https://s.shopee.co.id/wake-signal-test";
  const service = new ShopeeAffiliateLinkIntakeService(repository, async () => resolution);
  service.setRecoveryWakeSignal(() => { wakeSignals += 1; });

  const submitting = service.submit(affiliateUrl);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(wakeSignals, 0);
  assert.equal(await service.nextStaleResolvingAt(), undefined);

  resolve({
    status: "resolved",
    affiliateUrl,
    productUrl: "https://shopee.co.id/product/123/456",
    shopId: "123",
    itemId: "456"
  });
  const intake = await submitting;

  assert.equal(intake.status, "awaiting_offer_data");
  assert.equal(wakeSignals, 0);
  assert.equal(await service.nextStaleResolvingAt(), undefined);
});

test("legacy stale resolving recovery still wakes the scheduler when it claims and completes a row", async () => {
  const repository = new InMemoryShopeeAffiliateLinkIntakeRepository();
  const affiliateUrl = "https://s.shopee.co.id/legacy-wake-signal";
  const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
  await repository.saveIfAbsent({
    id: "legacy-wake-signal",
    marketplaceSlug: "shopee-affiliate-feed",
    affiliateUrl,
    normalizedUrlHash: createHash("sha256").update(affiliateUrl).digest("hex"),
    status: "resolving",
    sourceMetadata: {},
    createdAt: staleAt,
    updatedAt: staleAt
  });
  let wakeSignals = 0;
  const service = new ShopeeAffiliateLinkIntakeService(repository, async (url) => ({
    status: "resolved", affiliateUrl: url, productUrl: "https://shopee.co.id/product/123/456", shopId: "123", itemId: "456"
  }));
  service.setRecoveryWakeSignal(() => { wakeSignals += 1; });

  const result = await service.recoverStaleResolvingBatch({ batchSize: 1, concurrency: 1, resolverTimeoutMs: 1_000 });

  assert.deepEqual(result, { scanned: 1, recovered: 1, failed: 0, skipped: 0 });
  assert.equal(wakeSignals, 2);
  assert.equal(await service.nextStaleResolvingAt(), undefined);
});
