import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../../src/app.js";
import { createServices } from "../../src/domain/container.js";
import { InMemoryAffiliateOfferRepository, InMemoryCampaignOfferRepository, InMemoryClickRepository, InMemoryMarketplaceConnectionRepository, InMemoryProductCatalogRepository, InMemoryRepository, InMemoryTrackingLinkRepository } from "../../src/domain/repository.js";
import { InMemoryConversionAttributionRepository } from "../../src/domain/attribution.js";

function setup() {
  const repositories = {
    affiliates: new InMemoryRepository<any>(),
    offers: new InMemoryRepository<any>(),
    conversions: new InMemoryRepository<any>(),
    commissions: new InMemoryRepository<any>(),
    marketplaceConnections: new InMemoryMarketplaceConnectionRepository(),
    affiliateAccounts: new InMemoryRepository<any>(),
    products: new InMemoryProductCatalogRepository(),
    affiliateOffers: new InMemoryAffiliateOfferRepository(),
    campaigns: new InMemoryRepository<any>(),
    campaignOffers: new InMemoryCampaignOfferRepository(),
    trackingLinks: new InMemoryTrackingLinkRepository(),
    clicks: new InMemoryClickRepository(),
    contents: new InMemoryRepository<any>(),
    socialAccounts: new InMemoryRepository<any>()
  };
  const services = createServices(
    repositories,
    { run: (work) => work({ conversions: repositories.conversions, commissions: repositories.commissions }) },
    undefined,
    undefined,
    undefined,
    undefined,
    new InMemoryConversionAttributionRepository()
  );
  return { repositories, app: createApp(services) };
}

test("HTTP attribution flow feeds campaign analytics without implicit legacy attribution", async () => {
  const { repositories, app } = setup();
  const now = "2026-09-19T00:00:00.000Z";
  const campaignId = "00000000-0000-4000-8000-000000000401";
  const linkId = "00000000-0000-4000-8000-000000000402";
  const conversionId = "00000000-0000-4000-8000-000000000403";
  const affiliateId = "00000000-0000-4000-8000-000000000404";
  const offerId = "00000000-0000-4000-8000-000000000405";

  await repositories.campaigns.save({ id: campaignId, name: "HTTP attribution", objective: "sales", status: "active", audience: {}, createdAt: now, updatedAt: now });
  await repositories.affiliateOffers.save({ id: offerId, productId: "00000000-0000-4000-8000-000000000406", affiliateAccountId: "00000000-0000-4000-8000-000000000407", availability: "in_stock", availabilityMetadata: {}, affiliateLinkStatus: "active", status: "active", createdAt: now, updatedAt: now });
  await repositories.trackingLinks.save({ id: linkId, affiliateOfferId: offerId, campaignId, code: "httpattr", destinationUrl: "https://example.com", status: "active", createdAt: now, updatedAt: now });
  await repositories.clicks.save({ id: "00000000-0000-4000-8000-000000000408", trackingLinkId: linkId, occurredAt: now, metadata: {} });
  await repositories.affiliates.save({ id: affiliateId, name: "HTTP Partner", email: "http@example.com", status: "active", createdAt: now });
  await repositories.offers.save({ id: "00000000-0000-4000-8000-000000000409", name: "Legacy offer", status: "active", commissionRateBps: 1000, createdAt: now });
  await repositories.conversions.save({ id: conversionId, affiliateId, offerId: "00000000-0000-4000-8000-000000000409", amountCents: 25000, status: "approved", occurredAt: now });
  await repositories.commissions.save({ id: "00000000-0000-4000-8000-000000000410", conversionId, affiliateId, amountCents: 2500, status: "approved", createdAt: now });

  const attributionResponse = await app.inject({
    method: "POST",
    url: `/api/v1/conversions/${conversionId}/attribution`,
    payload: { trackingLinkId: linkId }
  });
  assert.equal(attributionResponse.statusCode, 201);
  assert.equal(attributionResponse.json().conversionId, conversionId);
  assert.equal(attributionResponse.json().trackingLinkId, linkId);

  const analyticsResponse = await app.inject({ method: "GET", url: `/api/v1/analytics/campaigns/${campaignId}` });
  assert.equal(analyticsResponse.statusCode, 200);
  assert.deepEqual(analyticsResponse.json(), {
    campaignId,
    clickCount: 1,
    trackingLinkCount: 1,
    contentCount: 0,
    publishedContentCount: 0,
    scheduledContentCount: 0,
    attributedConversionCount: 1,
    attributedRevenueCents: 25000,
    attributedCommissionCents: 2500,
    conversionRate: 1
  });

  const attributionRead = await app.inject({ method: "GET", url: `/api/v1/conversions/${conversionId}/attribution` });
  assert.equal(attributionRead.statusCode, 200);
  assert.equal(attributionRead.json().trackingLinkId, linkId);

  await app.close();
});

test("HTTP attribution rejects inactive tracking links", async () => {
  const { repositories, app } = setup();
  const now = "2026-09-19T00:00:00.000Z";
  const conversionId = "00000000-0000-4000-8000-000000000411";
  const linkId = "00000000-0000-4000-8000-000000000412";
  await repositories.conversions.save({ id: conversionId, affiliateId: "00000000-0000-4000-8000-000000000413", offerId: "00000000-0000-4000-8000-000000000414", amountCents: 1000, status: "pending", occurredAt: now });
  await repositories.trackingLinks.save({ id: linkId, affiliateOfferId: "00000000-0000-4000-8000-000000000415", code: "inactiveattr", destinationUrl: "https://example.com", status: "inactive", createdAt: now, updatedAt: now });

  const response = await app.inject({ method: "POST", url: `/api/v1/conversions/${conversionId}/attribution`, payload: { trackingLinkId: linkId } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "TRACKING_LINK_NOT_ACTIVE");
  await app.close();
});
