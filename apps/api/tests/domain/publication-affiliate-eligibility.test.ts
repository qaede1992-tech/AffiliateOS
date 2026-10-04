import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AffiliateOffer, Campaign, Content, Product } from "@affiliateos/shared";
import {
  InMemoryAffiliateOfferRepository,
  InMemoryCampaignOfferRepository,
  InMemoryClickRepository,
  InMemoryPublicationJobRepository,
  InMemoryRepository,
  InMemorySocialAccountRepository,
  InMemoryTrackingLinkRepository
} from "../../src/domain/repository.js";
import { CampaignService, TrackingService } from "../../src/domain/campaigns.js";
import { ContentService } from "../../src/domain/content.js";
import { DistributionEngine } from "../../src/domain/distribution-engine.js";
import { PublicationJobService } from "../../src/domain/publication-job-service.js";
import { PublisherExecutor } from "../../src/domain/publisher-executor.js";
import { PublicationWorker } from "../../src/domain/publication-worker.js";
import { RepositoryAffiliatePublicationEligibilityValidator } from "../../src/domain/affiliate-publication-eligibility.js";

const timestamps = {
  createdAt: "2026-10-04T00:00:00.000Z",
  scheduledAt: "2026-10-04T01:00:00.000Z"
};

const product: Product = {
  id: "product-publication-1",
  marketplaceId: "market-1",
  externalProductId: "external-publication-1",
  name: "Publication Test Product",
  description: "Publication eligibility regression fixture",
  category: "lifestyle",
  priceCents: 10000,
  currency: "IDR",
  ratingMilli: 4500,
  reviewCount: 100,
  soldCount: 1000,
  productUrl: "https://example.test/product",
  imageUrl: "https://example.test/product.jpg",
  status: "active",
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.createdAt
};

const offer: AffiliateOffer = {
  id: "affiliate-offer-publication-1",
  productId: product.id,
  affiliateAccountId: "affiliate-account-1",
  externalOfferId: "external-offer-publication-1",
  priceCents: 10000,
  currency: "IDR",
  commissionRateBps: 500,
  commissionAmountCents: 500,
  availability: "in_stock",
  availabilityMetadata: {},
  affiliateUrl: "https://s.shopee.co.id/publication-test",
  affiliateLinkStatus: "active",
  status: "active",
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.createdAt
};

const campaign: Campaign = {
  id: "campaign-publication-1",
  name: "Publication Eligibility Regression",
  objective: "Test publication eligibility revalidation",
  status: "draft",
  audience: { productId: product.id },
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.createdAt
};

describe("publication affiliate eligibility", () => {
  it("does not publish scheduled affiliate content after its source offer becomes inactive", async () => {
    const products = new InMemoryRepository<Product>();
    const campaigns = new InMemoryRepository<Campaign>();
    const affiliateOffers = new InMemoryAffiliateOfferRepository();
    const campaignOffers = new InMemoryCampaignOfferRepository();
    const trackingLinks = new InMemoryTrackingLinkRepository();
    const clicks = new InMemoryClickRepository();
    const contents = new InMemoryRepository<Content>();
    const socialAccounts = new InMemorySocialAccountRepository();
    const jobs = new InMemoryPublicationJobRepository();

    await products.save(product);
    await campaigns.save(campaign);
    await affiliateOffers.save(offer);
    await campaignOffers.save({ campaignId: campaign.id, affiliateOfferId: offer.id, createdAt: timestamps.createdAt });

    const campaignService = new CampaignService(campaigns, campaignOffers, affiliateOffers);
    const trackingService = new TrackingService(trackingLinks, clicks, campaigns, affiliateOffers, campaignOffers);
    await trackingService.create({
      affiliateOfferId: offer.id,
      campaignId: campaign.id,
      destinationUrl: offer.affiliateUrl!
    });

    const contentService = new ContentService(
      contents,
      campaigns,
      products,
      campaignOffers,
      trackingLinks
    );
    const publicationJobs = new PublicationJobService(jobs);
    const socialAccount = {
      id: "social-publication-1",
      platform: "instagram",
      accountReference: "publication-test-account",
      status: "active" as const,
      connection: {},
      createdAt: timestamps.createdAt,
      updatedAt: timestamps.createdAt
    };
    await socialAccounts.save(socialAccount);

    let publishCalls = 0;
    const publisher = {
      provider: "test-publication",
      supports: (platform: string) => platform === "instagram",
      publish: async () => {
        publishCalls += 1;
        return { status: "published" as const, externalPostId: "must-not-publish" };
      }
    };

    const distribution = new DistributionEngine(contentService, socialAccounts, [publisher], publicationJobs);
    const draft = await contentService.create({
      productId: product.id,
      campaignId: campaign.id,
      platform: "instagram",
      contentType: "affiliate-promotion",
      title: "Publication regression",
      caption: "Check the offer",
      status: "draft"
    });

    const scheduled = await distribution.schedule({ content: draft, scheduledAt: timestamps.scheduledAt });
    assert.equal(scheduled.content.status, "scheduled");
    assert.equal((await jobs.list()).length, 1);

    await affiliateOffers.save({
      ...offer,
      status: "inactive",
      updatedAt: "2026-10-04T00:30:00.000Z"
    });

    const eligibility = new RepositoryAffiliatePublicationEligibilityValidator(products, affiliateOffers, campaignOffers, trackingLinks);
    const executor = new PublisherExecutor(contentService, socialAccounts, [publisher], undefined, undefined, eligibility);
    const worker = new PublicationWorker(jobs, publicationJobs, executor, contentService);
    const results = await worker.runOnce(new Date("2026-10-04T02:00:00.000Z"));

    assert.equal(publishCalls, 0);
    assert.deepEqual(results[0]?.status, "failed");
    assert.match(results[0]?.error ?? "", /active, eligible affiliate offer and tracking link/);
    assert.equal((await contentService.get(draft.id)).status, "failed");
  });

  it("rejects affiliate promotion scheduling when no tracking link remains active", async () => {
    const products = new InMemoryRepository<Product>();
    const campaigns = new InMemoryRepository<Campaign>();
    const affiliateOffers = new InMemoryAffiliateOfferRepository();
    const campaignOffers = new InMemoryCampaignOfferRepository();
    const trackingLinks = new InMemoryTrackingLinkRepository();
    const clicks = new InMemoryClickRepository();
    const contents = new InMemoryRepository<Content>();

    await products.save(product);
    await campaigns.save(campaign);
    await affiliateOffers.save(offer);
    await campaignOffers.save({ campaignId: campaign.id, affiliateOfferId: offer.id, createdAt: timestamps.createdAt });

    const trackingService = new TrackingService(trackingLinks, clicks, campaigns, affiliateOffers, campaignOffers);
    const link = await trackingService.create({
      affiliateOfferId: offer.id,
      campaignId: campaign.id,
      destinationUrl: offer.affiliateUrl!
    });
    await trackingLinks.save({ ...link, status: "inactive" });

    const contentService = new ContentService(
      contents,
      campaigns,
      products,
      campaignOffers,
      trackingLinks
    );

    const draft = await contentService.create({
      productId: product.id,
      campaignId: campaign.id,
      platform: "instagram",
      contentType: "affiliate-promotion",
      status: "draft"
    });

    const eligibility = new RepositoryAffiliatePublicationEligibilityValidator(products, affiliateOffers, campaignOffers, trackingLinks);
    await assert.rejects(
      () => eligibility.validate(draft),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "AFFILIATE_OFFER_NOT_AVAILABLE")
    );
    assert.equal((await contentService.get(draft.id)).status, "draft");
  });
});
