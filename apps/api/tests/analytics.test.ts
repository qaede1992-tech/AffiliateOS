import assert from "node:assert/strict";
import test from "node:test";
import { AnalyticsService } from "../src/domain/analytics.js";
import { ConversionAttributionService, InMemoryConversionAttributionRepository } from "../src/domain/attribution.js";
import { TrackingService } from "../src/domain/campaigns.js";
import { InMemoryAffiliateOfferRepository, InMemoryCampaignOfferRepository, InMemoryClickRepository, InMemoryRepository, InMemoryTrackingLinkRepository } from "../src/domain/repository.js";

test("analytics aggregates campaign clicks, links, and content", async () => {
  const campaigns = new InMemoryRepository<import("@affiliateos/shared").Campaign>();
  const contents = new InMemoryRepository<import("@affiliateos/shared").Content>();
  const links = new InMemoryTrackingLinkRepository();
  const clicks = new InMemoryClickRepository();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const campaignOffers = new InMemoryCampaignOfferRepository();
  const tracking = new TrackingService(links, clicks, campaigns, affiliateOffers, campaignOffers);
  const analytics = new AnalyticsService(campaigns, links, clicks, contents);
  const campaign = await (new (class { constructor(private readonly c: InMemoryRepository<import("@affiliateos/shared").Campaign>) {} async create() { const now = new Date().toISOString(); const item = { id: "00000000-0000-0000-0000-000000000101", name: "Launch", objective: "sales", status: "active" as const, audience: {}, createdAt: now, updatedAt: now }; return this.c.save(item); } })(campaigns)).create();
  const offerId = "00000000-0000-0000-0000-000000000102";
  await affiliateOffers.save({ id: offerId, productId: "00000000-0000-0000-0000-000000000103", affiliateAccountId: "00000000-0000-0000-0000-000000000104", availability: "in_stock", availabilityMetadata: {}, affiliateLinkStatus: "active", affiliateUrl: "https://example.com", status: "active", createdAt: campaign.createdAt, updatedAt: campaign.updatedAt });
  await campaignOffers.save({ campaignId: campaign.id, affiliateOfferId: offerId, createdAt: campaign.createdAt });
  const link = await tracking.create({ affiliateOfferId: offerId, campaignId: campaign.id, destinationUrl: "https://example.com" });
  await tracking.recordClick(link.id, {});
  await tracking.recordClick(link.id, {});
  await contents.save({ id: "00000000-0000-0000-0000-000000000105", campaignId: campaign.id, platform: "instagram", contentType: "post", status: "published", createdAt: campaign.createdAt, updatedAt: campaign.updatedAt });
  await contents.save({ id: "00000000-0000-0000-0000-000000000106", campaignId: campaign.id, platform: "tiktok", contentType: "video", status: "scheduled", scheduledAt: "2026-10-01T10:00:00.000Z", createdAt: campaign.createdAt, updatedAt: campaign.updatedAt });

  assert.deepEqual(await analytics.campaign(campaign.id), { campaignId: campaign.id, clickCount: 2, trackingLinkCount: 1, contentCount: 2, publishedContentCount: 1, scheduledContentCount: 1, attributedConversionCount: 0, attributedRevenueCents: 0, attributedCommissionCents: 0, conversionRate: 0 });
  const overview = await analytics.overview();
  assert.equal(overview.clickCount, 2);
  assert.equal(overview.trackingLinkCount, 1);
  assert.equal(overview.campaigns[0]?.clickCount, 2);
});

test("analytics includes explicitly attributed conversion revenue and commission", async () => {
  const campaigns = new InMemoryRepository<import("@affiliateos/shared").Campaign>();
  const contents = new InMemoryRepository<import("@affiliateos/shared").Content>();
  const links = new InMemoryTrackingLinkRepository();
  const clicks = new InMemoryClickRepository();
  const conversions = new InMemoryRepository<import("@affiliateos/shared").Conversion>();
  const commissions = new InMemoryRepository<import("@affiliateos/shared").Commission>();
  const attributions = new InMemoryConversionAttributionRepository();
  const now = new Date().toISOString();
  const campaignId = "00000000-0000-0000-0000-000000000201";
  const linkId = "00000000-0000-0000-0000-000000000202";
  const conversionId = "00000000-0000-0000-0000-000000000203";
  await campaigns.save({ id: campaignId, name: "Attributed", objective: "sales", status: "active", audience: {}, createdAt: now, updatedAt: now });
  await links.save({ id: linkId, affiliateOfferId: "00000000-0000-0000-0000-000000000204", campaignId, code: "attr1", destinationUrl: "https://example.com", status: "active", createdAt: now, updatedAt: now });
  await clicks.save({ id: "00000000-0000-0000-0000-000000000205", trackingLinkId: linkId, occurredAt: now, metadata: {} });
  await conversions.save({ id: conversionId, affiliateId: "00000000-0000-0000-0000-000000000206", offerId: "00000000-0000-0000-0000-000000000207", amountCents: 12500, status: "approved", occurredAt: now });
  await commissions.save({ id: "00000000-0000-0000-0000-000000000208", conversionId, affiliateId: "00000000-0000-0000-0000-000000000206", amountCents: 1250, status: "approved", createdAt: now });
  await new ConversionAttributionService(conversions, links, attributions).create(conversionId, { trackingLinkId: linkId });

  const analytics = new AnalyticsService(campaigns, links, clicks, contents, undefined, conversions, commissions, attributions);
  assert.deepEqual(await analytics.campaign(campaignId), { campaignId, clickCount: 1, trackingLinkCount: 1, contentCount: 0, publishedContentCount: 0, scheduledContentCount: 0, attributedConversionCount: 1, attributedRevenueCents: 12500, attributedCommissionCents: 1250, conversionRate: 1 });
});

test("analytics excludes commissions belonging to rejected attributed conversions", async () => {
  const campaigns = new InMemoryRepository<import("@affiliateos/shared").Campaign>();
  const contents = new InMemoryRepository<import("@affiliateos/shared").Content>();
  const links = new InMemoryTrackingLinkRepository();
  const clicks = new InMemoryClickRepository();
  const conversions = new InMemoryRepository<import("@affiliateos/shared").Conversion>();
  const commissions = new InMemoryRepository<import("@affiliateos/shared").Commission>();
  const attributions = new InMemoryConversionAttributionRepository();
  const now = new Date().toISOString();
  const campaignId = "00000000-0000-0000-0000-000000000301";
  const linkId = "00000000-0000-0000-0000-000000000302";
  const conversionId = "00000000-0000-0000-0000-000000000303";
  await campaigns.save({ id: campaignId, name: "Rejected", objective: "sales", status: "active", audience: {}, createdAt: now, updatedAt: now });
  await links.save({ id: linkId, affiliateOfferId: "00000000-0000-0000-0000-000000000304", campaignId, code: "reject1", destinationUrl: "https://example.com", status: "active", createdAt: now, updatedAt: now });
  await conversions.save({ id: conversionId, affiliateId: "00000000-0000-0000-0000-000000000305", offerId: "00000000-0000-0000-0000-000000000304", amountCents: 5000, status: "rejected", occurredAt: now });
  await commissions.save({ id: "00000000-0000-0000-0000-000000000307", conversionId, affiliateId: "00000000-0000-0000-0000-000000000305", amountCents: 500, status: "rejected", createdAt: now });
  await new ConversionAttributionService(conversions, links, attributions).create(conversionId, { trackingLinkId: linkId });

  const analytics = new AnalyticsService(campaigns, links, clicks, contents, undefined, conversions, commissions, attributions);
  const result = await analytics.campaign(campaignId);
  assert.equal(result.attributedConversionCount, 0);
  assert.equal(result.attributedRevenueCents, 0);
  assert.equal(result.attributedCommissionCents, 0);
});

test("analytics delegates to the database reader when configured", async () => {
  const reader = {
    async overview() { return { clickCount: 7, trackingLinkCount: 3, campaignCount: 2, contentCount: 4, publishedContentCount: 2, scheduledContentCount: 1, attributedConversionCount: 0, attributedRevenueCents: 0, attributedCommissionCents: 0, conversionRate: 0, campaigns: [] }; },
    async campaign(campaignId: string) { return { campaignId, clickCount: 7, trackingLinkCount: 3, contentCount: 4, publishedContentCount: 2, scheduledContentCount: 1, attributedConversionCount: 0, attributedRevenueCents: 0, attributedCommissionCents: 0, conversionRate: 0 }; }
  };
  const analytics = new AnalyticsService(new InMemoryRepository(), new InMemoryTrackingLinkRepository(), new InMemoryClickRepository(), new InMemoryRepository(), reader);
  assert.equal((await analytics.overview()).clickCount, 7);
  assert.equal((await analytics.campaign("00000000-0000-0000-0000-000000000101")).clickCount, 7);
});

test("analytics rejects an unknown campaign", async () => {
  const services = new AnalyticsService(new InMemoryRepository(), new InMemoryTrackingLinkRepository(), new InMemoryClickRepository(), new InMemoryRepository());
  await assert.rejects(() => services.campaign("00000000-0000-0000-0000-000000000999"), /campaign does not exist/i);
});
