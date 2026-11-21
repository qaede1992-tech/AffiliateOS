import assert from "node:assert/strict";
import test from "node:test";
import { TrackingService } from "../src/domain/campaigns.js";
import { InMemoryAffiliateOfferRepository, InMemoryCampaignOfferRepository, InMemoryClickRepository, InMemoryRepository, InMemoryTrackingLinkRepository } from "../src/domain/repository.js";

test("tracking redirects attach the AffiliateOS code as Shopee sub_id", async () => {
  const links = new InMemoryTrackingLinkRepository();
  const clicks = new InMemoryClickRepository();
  const campaigns = new InMemoryRepository();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const campaignOffers = new InMemoryCampaignOfferRepository();
  const tracking = new TrackingService(links, clicks, campaigns, affiliateOffers, campaignOffers);
  const offerId = "00000000-0000-0000-0000-000000000081";
  await affiliateOffers.save({
    id: offerId,
    productId: "00000000-0000-0000-0000-000000000091",
    affiliateAccountId: "00000000-0000-0000-0000-000000000092",
    availability: "in_stock",
    availabilityMetadata: {},
    affiliateUrl: "https://s.shopee.co.id/example-short-link",
    affiliateLinkStatus: "active",
    status: "active",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z"
  });
  const link = await tracking.create({
    affiliateOfferId: offerId,
    code: "shopee-track-1",
    destinationUrl: "https://s.shopee.co.id/example-short-link"
  });
  const destination = await tracking.redirect(link.code, { source: "public-redirect" });
  assert.equal(destination, "https://s.shopee.co.id/example-short-link?sub_id=shopee-track-1");
  assert.equal((await clicks.listByTrackingLink(link.id)).length, 1);
});


test("tracking redirects reject an affiliate link that expires after tracking-link creation", async () => {
  const links = new InMemoryTrackingLinkRepository();
  const clicks = new InMemoryClickRepository();
  const campaigns = new InMemoryRepository();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const tracking = new TrackingService(links, clicks, campaigns, affiliateOffers, new InMemoryCampaignOfferRepository());
  const offerId = "00000000-0000-0000-0000-000000000082";
  const offer = {
    id: offerId,
    productId: "00000000-0000-0000-0000-000000000091",
    affiliateAccountId: "00000000-0000-0000-0000-000000000092",
    availability: "in_stock" as const,
    availabilityMetadata: {},
    affiliateUrl: "https://s.shopee.co.id/expiring-link",
    affiliateLinkStatus: "active" as const,
    status: "active" as const,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z"
  };
  await affiliateOffers.save(offer);
  const link = await tracking.create({ affiliateOfferId: offerId, code: "shopee-track-expired", destinationUrl: offer.affiliateUrl });
  await affiliateOffers.save({ ...offer, affiliateLinkExpiresAt: "2000-01-01T00:00:00.000Z" });

  await assert.rejects(() => tracking.redirect(link.code), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "AFFILIATE_LINK_EXPIRED"
  );
  assert.equal((await clicks.listByTrackingLink(link.id)).length, 0);
});

test("tracking redirects reject an affiliate URL that has been replaced", async () => {
  const links = new InMemoryTrackingLinkRepository();
  const clicks = new InMemoryClickRepository();
  const campaigns = new InMemoryRepository();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const tracking = new TrackingService(links, clicks, campaigns, affiliateOffers, new InMemoryCampaignOfferRepository());
  const offerId = "00000000-0000-0000-0000-000000000083";
  const offer = {
    id: offerId,
    productId: "00000000-0000-0000-0000-000000000091",
    affiliateAccountId: "00000000-0000-0000-0000-000000000092",
    availability: "in_stock" as const,
    availabilityMetadata: {},
    affiliateUrl: "https://s.shopee.co.id/old-link",
    affiliateLinkStatus: "active" as const,
    status: "active" as const,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z"
  };
  await affiliateOffers.save(offer);
  const link = await tracking.create({ affiliateOfferId: offerId, code: "shopee-track-replaced", destinationUrl: offer.affiliateUrl });
  await affiliateOffers.save({ ...offer, affiliateUrl: "https://s.shopee.co.id/new-link" });

  await assert.rejects(() => tracking.redirect(link.code), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "AFFILIATE_LINK_DESTINATION_MISMATCH"
  );
  assert.equal((await clicks.listByTrackingLink(link.id)).length, 0);
});
