import assert from "node:assert/strict";
import test from "node:test";
import type { CampaignOffer, Click, TrackingLink } from "@affiliateos/shared";
import { CampaignService, TrackingService } from "../src/domain/campaigns.js";
import { InMemoryAffiliateOfferRepository, InMemoryCampaignOfferRepository, InMemoryClickRepository, InMemoryRepository, InMemoryTrackingLinkRepository } from "../src/domain/repository.js";
import { createInMemoryServices } from "../src/domain/container.js";

test("campaign creation persists in the service repository", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales" });
  assert.equal((await services.campaigns.get(campaign.id)).name, "Launch");
});

test("campaign updates preserve the start/end date invariant", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Launch", objective: "sales", startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-10-31T00:00:00.000Z" });
  await assert.rejects(() => services.campaigns.update(campaign.id, { endAt: "2026-09-30T00:00:00.000Z" }), /startAt must be before endAt/i);
  assert.equal((await services.campaigns.get(campaign.id)).endAt, "2026-10-31T00:00:00.000Z");
});

test("campaign date validation compares timestamps across offsets", async () => {
  const services = createInMemoryServices();
  const campaign = await services.campaigns.create({ name: "Offset launch", objective: "sales", startAt: "2026-10-01T00:00:00.000+07:00", endAt: "2026-09-30T20:00:00.000Z" });
  assert.equal(campaign.startAt, "2026-10-01T00:00:00.000+07:00");
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
  await assert.rejects(() => services.tracking.create({ affiliateOfferId: "00000000-0000-0000-0000-000000000001", campaignId: campaign.id, destinationUrl: "https://example.com" }), /affiliate offer does not exist/i);
});

function activeOffer(id: string) {
  return {
    id,
    productId: "00000000-0000-0000-0000-000000000011",
    affiliateAccountId: "00000000-0000-0000-0000-000000000012",
    availability: "in_stock" as const,
    availabilityMetadata: {},
    affiliateUrl: "https://example.com/affiliate",
    affiliateLinkStatus: "active" as const,
    status: "active" as const,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z"
  };
}

function trackingFixture() {
  const links = new InMemoryTrackingLinkRepository();
  const clicks = new InMemoryClickRepository();
  const campaigns = new InMemoryRepository<import("@affiliateos/shared").Campaign>();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const campaignOffers = new InMemoryCampaignOfferRepository();
  return { links, clicks, campaigns, affiliateOffers, campaignOffers, tracking: new TrackingService(links, clicks, campaigns, affiliateOffers, campaignOffers) };
}

test("tracking links reject expired affiliate links and destination mismatches", async () => {
  const { affiliateOffers, tracking } = trackingFixture();
  const expiredId = "00000000-0000-0000-0000-000000000070";
  await affiliateOffers.save({ ...activeOffer(expiredId), affiliateUrl: "https://example.com/affiliate", affiliateLinkExpiresAt: "2000-01-01T00:00:00.000Z" });
  await assert.rejects(() => tracking.create({ affiliateOfferId: expiredId, destinationUrl: "https://example.com/affiliate" }), /expired affiliate link/i);

  const activeId = "00000000-0000-0000-0000-000000000071";
  await affiliateOffers.save({ ...activeOffer(activeId), affiliateUrl: "https://example.com/affiliate" });
  await assert.rejects(() => tracking.create({ affiliateOfferId: activeId, destinationUrl: "https://example.com/other" }), /active affiliate URL/i);
});

test("click recording is idempotent for the same tracking link and key", async () => {
  const { links, clicks, affiliateOffers, tracking } = trackingFixture();
  const offerId = "00000000-0000-0000-0000-000000000010";
  await affiliateOffers.save(activeOffer(offerId));
  const link = await tracking.create({ affiliateOfferId: offerId, destinationUrl: "https://example.com/affiliate" });
  const first = await tracking.recordClick(link.id, { idempotencyKey: "click-key-1234", metadata: { source: "test" } });
  const second = await tracking.recordClick(link.id, { idempotencyKey: "click-key-1234", metadata: { source: "retry" } });
  assert.equal(second.id, first.id);
  assert.equal(second.idempotencyKey, "click-key-1234");
  assert.equal((await clicks.listByTrackingLink(link.id)).length, 1);
  assert.deepEqual(first.metadata, { source: "test" });
  assert.equal((await links.findByCode(link.code))?.id, link.id);
});

test("the same idempotency key can be reused on different tracking links", async () => {
  const { clicks, affiliateOffers, tracking } = trackingFixture();
  const offerId = "00000000-0000-0000-0000-000000000015";
  await affiliateOffers.save(activeOffer(offerId));
  const firstLink = await tracking.create({ affiliateOfferId: offerId, code: "link-one", destinationUrl: "https://example.com/affiliate" });
  const secondLink = await tracking.create({ affiliateOfferId: offerId, code: "link-two", destinationUrl: "https://example.com/affiliate" });
  await tracking.recordClick(firstLink.id, { idempotencyKey: "shared-key" });
  await tracking.recordClick(secondLink.id, { idempotencyKey: "shared-key" });
  assert.equal((await clicks.listByTrackingLink(firstLink.id)).length, 1);
  assert.equal((await clicks.listByTrackingLink(secondLink.id)).length, 1);
});

test("tracking redirects record a click and return the bound destination", async () => {\n  const { clicks, affiliateOffers, tracking } = trackingFixture();\n  const offerId = "00000000-0000-0000-0000-000000000080";\n  await affiliateOffers.save(activeOffer(offerId));\n  const link = await tracking.create({ affiliateOfferId: offerId, code: "redirect-code", destinationUrl: "https://example.com/affiliate" });\n  const destination = await tracking.redirect(link.code, { source: "public-redirect", userAgent: "test-agent" });\n  assert.equal(destination, "https://example.com/affiliate");\n  const recorded = await clicks.listByTrackingLink(link.id);\n  assert.equal(recorded.length, 1);\n  assert.deepEqual(recorded[0].metadata, { source: "public-redirect", userAgent: "test-agent" });\n});\n\ntest("clicks reject inactive tracking links", async () => {
  const { links, affiliateOffers, tracking } = trackingFixture();
  const offerId = "00000000-0000-0000-0000-000000000030";
  await affiliateOffers.save(activeOffer(offerId));
  const link = await tracking.create({ affiliateOfferId: offerId, destinationUrl: "https://example.com/affiliate" });
  await links.save({ ...link, status: "inactive" });
  await assert.rejects(() => tracking.recordClick(link.id, {}), /active tracking link/i);
});

test("tracking link stats use the repository count", async () => {
  const { tracking, affiliateOffers } = trackingFixture();
  const offerId = "00000000-0000-0000-0000-000000000020";
  await affiliateOffers.save(activeOffer(offerId));
  const link = await tracking.create({ affiliateOfferId: offerId, destinationUrl: "https://example.com/affiliate" });
  await tracking.recordClick(link.id, {});
  await tracking.recordClick(link.id, {});
  assert.deepEqual(await tracking.stats(link.id), { linkId: link.id, clickCount: 2 });
});

class RaceCampaignOfferRepository extends InMemoryCampaignOfferRepository {
  private firstSave = true;
  override async save(entity: CampaignOffer) {
    if (this.firstSave) {
      this.firstSave = false;
      await super.save(entity);
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    return super.save(entity);
  }
}

test("campaign offer attachment tolerates a unique-constraint race", async () => {
  const campaigns = new InMemoryRepository<import("@affiliateos/shared").Campaign>();
  const campaignOffers = new RaceCampaignOfferRepository();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const service = new CampaignService(campaigns, campaignOffers, affiliateOffers);
  const campaign = await service.create({ name: "Race", objective: "sales" });
  const offerId = "00000000-0000-0000-0000-000000000040";
  await affiliateOffers.save(activeOffer(offerId));
  const attached = await service.attachOffer(campaign.id, offerId);
  assert.equal(attached.affiliateOfferId, offerId);
});

class RaceTrackingLinkRepository extends InMemoryTrackingLinkRepository {
  private firstSave = true;
  override async save(entity: TrackingLink) {
    if (this.firstSave) {
      this.firstSave = false;
      await super.save({ ...entity, id: "00000000-0000-0000-0000-000000000051" });
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    return super.save(entity);
  }
}

test("tracking link creation converts a unique-constraint race into a conflict", async () => {
  const links = new RaceTrackingLinkRepository();
  const clicks = new InMemoryClickRepository();
  const campaigns = new InMemoryRepository<import("@affiliateos/shared").Campaign>();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const campaignOffers = new InMemoryCampaignOfferRepository();
  const tracking = new TrackingService(links, clicks, campaigns, affiliateOffers, campaignOffers);
  const offerId = "00000000-0000-0000-0000-000000000050";
  await affiliateOffers.save(activeOffer(offerId));
  await assert.rejects(() => tracking.create({ affiliateOfferId: offerId, code: "race-code", destinationUrl: "https://example.com/affiliate" }), /already in use/i);
});

class RaceClickRepository extends InMemoryClickRepository {
  private firstSave = true;
  override async save(entity: Click) {
    if (this.firstSave) {
      this.firstSave = false;
      await super.save(entity);
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    return super.save(entity);
  }
}

test("click idempotency converts a unique-constraint race into the original click", async () => {
  const links = new InMemoryTrackingLinkRepository();
  const clicks = new RaceClickRepository();
  const campaigns = new InMemoryRepository<import("@affiliateos/shared").Campaign>();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const campaignOffers = new InMemoryCampaignOfferRepository();
  const tracking = new TrackingService(links, clicks, campaigns, affiliateOffers, campaignOffers);
  const offerId = "00000000-0000-0000-0000-000000000060";
  await affiliateOffers.save(activeOffer(offerId));
  const link = await tracking.create({ affiliateOfferId: offerId, destinationUrl: "https://example.com/affiliate" });
  const click = await tracking.recordClick(link.id, { idempotencyKey: "race-click-key" });
  assert.equal(click.idempotencyKey, "race-click-key");
  assert.equal((await clicks.listByTrackingLink(link.id)).length, 1);
});
