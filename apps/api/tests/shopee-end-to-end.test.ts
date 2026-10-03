import assert from "node:assert/strict";
import test from "node:test";
import type { Affiliate, AffiliateAccount, AffiliateOffer, Offer } from "@affiliateos/shared";
import {
  InMemoryAffiliateAccountRepository,
  InMemoryAffiliateOfferRepository,
  InMemoryAffiliateRepository,
  InMemoryCommissionRepository,
  InMemoryConversionRepository,
  InMemoryClickRepository,
  InMemoryRepository,
  InMemoryTrackingLinkRepository
} from "../src/domain/repository.js";
import { ConversionService } from "../src/domain/services.js";
import { ConversionAttributionService, InMemoryConversionAttributionRepository } from "../src/domain/attribution.js";
import { TrackingService } from "../src/domain/campaigns.js";
import { ProviderConversionProcessor } from "../src/domain/provider-conversion-processor.js";
import { ShopeeCommissionReportReconciliationService } from "../src/domain/shopee-commission-report-reconciliation.js";
import { AnalyticsService } from "../src/domain/analytics.js";

test("Shopee synthetic flow: tracking -> sub_id -> click -> report -> conversion -> attribution -> commission -> analytics", async () => {
  const affiliateId = "00000000-0000-0000-0000-000000000101";
  const offerId = "00000000-0000-0000-0000-000000000102";
  const accountId = "00000000-0000-0000-0000-000000000103";
  const affiliateOfferId = "00000000-0000-0000-0000-000000000104";
  const productId = "00000000-0000-0000-0000-000000000105";

  const affiliates = new InMemoryRepository<Affiliate>();
  const offers = new InMemoryRepository<Offer>();
  const affiliateAccounts = new InMemoryAffiliateAccountRepository();
  const affiliateOffers = new InMemoryAffiliateOfferRepository();
  const conversions = new InMemoryConversionRepository();
  const commissions = new InMemoryCommissionRepository();
  const trackingLinks = new InMemoryTrackingLinkRepository();
  const clicks = new InMemoryClickRepository();
  const campaigns = new InMemoryRepository<any>();
  const contents = new InMemoryRepository<any>();
  const attributions = new InMemoryConversionAttributionRepository();

  const affiliate: Affiliate = {
    id: affiliateId,
    name: "Synthetic Affiliate",
    email: "synthetic@example.invalid",
    status: "active",
    createdAt: "2026-10-04T08:00:00.000Z"
  };
  const offer: Offer = {
    id: offerId,
    name: "Synthetic Shopee Offer",
    status: "active",
    commissionRateBps: 1500,
    createdAt: "2026-10-04T08:00:00.000Z"
  };
  const account: AffiliateAccount = {
    id: accountId,
    marketplaceId: "00000000-0000-0000-0000-000000000106",
    affiliateId,
    name: "Synthetic Shopee Account",
    status: "active",
    configuration: {},
    createdAt: "2026-10-04T08:00:00.000Z",
    updatedAt: "2026-10-04T08:00:00.000Z"
  };
  const affiliateOffer: AffiliateOffer = {
    id: affiliateOfferId,
    productId,
    conversionOfferId: offerId,
    affiliateAccountId: accountId,
    externalOfferId: "synthetic-offer-1",
    priceCents: 1250000,
    currency: "IDR",
    commissionRateBps: 1500,
    availability: "in_stock",
    availabilityMetadata: {},
    affiliateUrl: "https://s.shopee.co.id/synthetic-short-link",
    affiliateLinkStatus: "active",
    status: "active",
    createdAt: "2026-10-04T08:00:00.000Z",
    updatedAt: "2026-10-04T08:00:00.000Z"
  };

  await affiliates.save(affiliate);
  await offers.save(offer);
  await affiliateAccounts.save(account);
  await affiliateOffers.save(affiliateOffer);

  const tracking = new TrackingService(
    trackingLinks,
    clicks,
    campaigns,
    affiliateOffers,
    { find: async () => undefined, save: async (value: any) => value, listByCampaign: async () => [] }
  );

  const link = await tracking.create({
    affiliateOfferId,
    code: "synthetic-shopee-1",
    destinationUrl: affiliateOffer.affiliateUrl!
  });
  const destination = await tracking.redirect(link.code, {
    source: "synthetic-e2e",
    userAgent: "AffiliateOS-test"
  });

  assert.equal(
    destination,
    "https://s.shopee.co.id/synthetic-short-link?sub_id=synthetic-shopee-1"
  );
  assert.equal((await clicks.listByTrackingLink(link.id)).length, 1);

  const transactionManager = {
    run: async <T>(work: (repositories: { conversions: typeof conversions; commissions: typeof commissions }) => Promise<T>) =>
      work({ conversions, commissions })
  };

  const conversionService = new ConversionService(
    conversions,
    commissions,
    affiliates,
    offers,
    affiliateOffers,
    transactionManager
  );
  const attribution = new ConversionAttributionService(conversions, trackingLinks, attributions);

  const providerConversions = new ProviderConversionProcessor(
    conversionService,
    {
      resolveAffiliate: async (reference) => (await affiliates.findById(reference))?.id,
      resolveOffer: async (reference) => (await offers.findById(reference))?.id,
      resolveTracking: async (accountScope, reference) => {
        const trackingLink = await trackingLinks.findByCode(reference);
        const scopedAccount = await affiliateAccounts.findById(accountScope);
        if (!trackingLink || !scopedAccount?.affiliateId) return undefined;
        const linkedOffer = await affiliateOffers.findById(trackingLink.affiliateOfferId);
        if (!linkedOffer || linkedOffer.affiliateAccountId !== scopedAccount.id || linkedOffer.conversionOfferId !== offerId) return undefined;
        return {
          affiliateId: scopedAccount.affiliateId,
          offerId,
          affiliateOfferId: linkedOffer.id,
          trackingLinkId: trackingLink.id
        };
      }
    },
    {
      attribute: async (conversionId, trackingLinkId) => {
        await attribution.create(conversionId, { trackingLinkId }, { allowInactiveTrackingLink: true });
      }
    }
  );

  const reconciliation = new ShopeeCommissionReportReconciliationService(
    { getAffiliateAccount: async () => account } as any,
    providerConversions
  );

  const report = await reconciliation.reconcile("shopee-account-synthetic", {
    sourceReference: "synthetic-report-2026-10-04",
    rows: [{
      rowKey: "synthetic-order-1",
      trackingReference: link.code,
      amountCents: 1250000,
      commissionCents: 95000,
      occurredAt: "2026-10-04T09:00:00.000Z",
      status: "approved"
    }]
  });

  assert.deepEqual(report, {
    sourceReference: "synthetic-report-2026-10-04",
    processed: 1,
    failed: 0,
    failures: []
  });

  const conversionList = await conversions.list();
  const commissionList = await commissions.list();
  const attributionList = await attributions.list();

  assert.equal(conversionList.length, 1);
  assert.equal(conversionList[0].affiliateId, affiliateId);
  assert.equal(conversionList[0].offerId, offerId);
  assert.equal(conversionList[0].affiliateOfferId, affiliateOfferId);
  assert.equal(conversionList[0].status, "approved");
  assert.equal(commissionList.length, 1);
  assert.equal(commissionList[0].amountCents, 95000);
  assert.equal(commissionList[0].status, "approved");
  assert.deepEqual(attributionList[0], {
    conversionId: conversionList[0].id,
    trackingLinkId: link.id,
    attributedAt: attributionList[0].attributedAt
  });

  const analytics = new AnalyticsService(
    campaigns,
    trackingLinks,
    clicks,
    contents,
    undefined,
    conversions,
    commissions,
    attributions
  );
  const overview = await analytics.overview();

  assert.equal(overview.clickCount, 1);
  assert.equal(overview.trackingLinkCount, 1);
  assert.equal(overview.attributedConversionCount, 1);
  assert.equal(overview.attributedRevenueCents, 1250000);
  assert.equal(overview.attributedCommissionCents, 95000);
  assert.equal(overview.conversionRate, 1);
});
