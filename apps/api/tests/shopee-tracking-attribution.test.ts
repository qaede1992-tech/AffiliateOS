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
