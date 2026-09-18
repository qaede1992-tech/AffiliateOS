import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryServices } from "../src/domain/container.js";
import { InMemoryAffiliateOfferRepository, InMemoryCampaignOfferRepository, InMemoryClickRepository, InMemoryRepository, InMemoryTrackingLinkRepository } from "../src/domain/repository.js";
import { TrackingService } from "../src/domain/campaigns.js";

test("campaign creation persists in the service repository", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales" });
  assert.equal((await services.campaigns.get(campaign.id)).name, "Launch");
});

test("campaign updates preserve the start/end date invariant", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({
    name: "Launch",
    objective: "sales",
    startAt: "2026-10-01T00:00:00.000Z",
    endAt: "2026-10-31T00:00:00.000Z"
  });

  await assert.rejects(
    () => services.campaigns.update(campaign.id, { endAt: "2026-09-30T00:00:00.000Z" }),
    /startAt must be before endAt/i
  );
  assert.equal((await services.campaigns.get(campaign.id)).endAt, "2026-10-31T00:00:00.000Z");
});

test("campaign lifecycle rejects invalid transitions", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales", status: "draft" });
  await services.campaigns.update(campaign.id, { status: "active" });
  await services.campaigns.update(campaign.id, { status: "paused" });
  await assert.rejects(() => services.campaigns.update(campaign.id, { status: "draft" }), /cannot transition/i);
});

test("campaign offer reads reject an unknown campaign", async () => {
  const services = createInMemoryServices();
  await assert.rejects(() => services.campaigns.listOffers("00000000-0000-0000-0000-000000000001"), /campaign does not exist/i);
});

test("tracking link filters reject an unknown campaign", async () => {
  const services = createInMemoryServices();
  await assert.rejects(() => services.tracking.list("00000000-0000-0000-0000-000000000001"), /campaign does not exist/i);
});

test("tracking links reject unknown affiliate offers", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales" });
  await assert.rejects(
    () => services.tracking.create({ affiliateOfferId: "00000000-0000-0000-0000-000000000001", campaignId: campaign.id, destinationUrl: "https://example.com" }),
    /affiliate offer does not exist/i
  );
});

test("click recording is idempotent for the same tracking link and key", async () => {
  const links = new InMemoryTrackingLinkRepository();
  const clicks = new InMemoryClickRepository();
  const campaigns = new InMemoryRepository<import("@affiliateos/shared").Campaign>();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const campaignOffers = new InMemoryCampaignOfferRepository();
  const tracking = new TrackingService(links, clicks, campaigns, affiliateOffers, campaignOffers);
  const offerId = "00000000-0000-0000-0000-000000000010";
  const offer = {
    id: offerId,
    productId: "00000000-0000-0000-0000-000000000011",
    affiliateAccountId: "00000000-0000-0000-0000-000000000012",
    availability: "in_stock" as const,
    availabilityMetadata: {},
    affiliateLinkStatus: "active" as const,
    status: "active" as const,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z"
  };
  await affiliateOffers.save(offer);
  const link = await tracking.create({ affiliateOfferId: offerId, destinationUrl: "https://example.com" });
  const first = await tracking.recordClick(link.id, { idempotencyKey: "click-key-1234", metadata: { source: "test" } });
  const second = await tracking.recordClick(link.id, { idempotencyKey: "click-key-1234", metadata: { source: "retry" } });
  assert.equal(second.id, first.id);
  assert.equal((await clicks.listByTrackingLink(link.id)).length, 1);
  assert.deepEqual(first.metadata, { source: "test", idempotencyKey: "click-key-1234" });
});

test("tracking link stats use the repository count", async () => {
  const links = new InMemoryTrackingLinkRepository();
  const clicks = new InMemoryClickRepository();
  const campaigns = new InMemoryRepository<import("@affiliateos/shared").Campaign>();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const campaignOffers = new InMemoryCampaignOfferRepository();
  const tracking = new TrackingService(links, clicks, campaigns, affiliateOffers, campaignOffers);
  const offerId = "00000000-0000-0000-0000-000000000020";
  await affiliateOffers.save({
    id: offerId,
    productId: "00000000-0000-0000-0000-000000000021",
    affiliateAccountId: "00000000-0000-0000-0000-000000000022",
    availability: "in_stock",
    availabilityMetadata: {},
    affiliateLinkStatus: "active",
    status: "active",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z"
  });
  const link = await tracking.create({ affiliateOfferId: offerId, destinationUrl: "https://example.com" });
  await tracking.recordClick(link.id, {});
  await tracking.recordClick(link.id, {});
  assert.deepEqual(await tracking.stats(link.id), { linkId: link.id, clickCount: 2 });
});
