import type { Affiliate, Campaign, Commission, Content, Conversion, Offer, SocialAccount } from "@affiliateos/shared";
import { InMemoryAffiliateAccountRepository, InMemoryAffiliateOfferRepository, InMemoryCampaignOfferRepository, InMemoryClickRepository, InMemoryMarketplaceConnectionRepository, InMemoryProductCatalogRepository, InMemoryRepository, InMemorySocialAccountRepository, InMemoryTrackingLinkRepository, type RepositorySet, type TransactionManager } from "./repository.js";
import { AffiliateService, CommissionService, ConversionService, OfferService } from "./services.js";
import { MarketplaceProviderRegistry } from "./foundations.js";
import { MarketplaceService } from "./marketplace.js";
import { CampaignService, TrackingService } from "./campaigns.js";
import { ContentService, SocialAccountService } from "./content.js";
import { AnalyticsService } from "./analytics.js";
import type { AnalyticsReader } from "./analytics-db.js";
import { ConversionAttributionService, InMemoryConversionAttributionRepository, type ConversionAttributionRepository } from "./attribution.js";
import { InMemoryOAuthStateRepository, InMemorySocialOAuthProviderRegistry, SocialOAuthService, type OAuthStateRepository } from "./oauth.js";

export interface Services {
  affiliates: AffiliateService; offers: OfferService; conversions: ConversionService; commissions: CommissionService; marketplace: MarketplaceService;
  campaigns: CampaignService; tracking: TrackingService; content: ContentService; socialAccounts: SocialAccountService; socialOAuth: SocialOAuthService; analytics: AnalyticsService; attribution: ConversionAttributionService;
}

export function createServices(repositories: RepositorySet, transactionManager: TransactionManager, marketplaceRegistry = new MarketplaceProviderRegistry(), socialOAuthRegistry = new InMemorySocialOAuthProviderRegistry(), oauthStateRepository: OAuthStateRepository = new InMemoryOAuthStateRepository(), analyticsReader?: AnalyticsReader, attributionRepository: ConversionAttributionRepository = new InMemoryConversionAttributionRepository()): Services {
  return {
    affiliates: new AffiliateService(repositories.affiliates), offers: new OfferService(repositories.offers),
    conversions: new ConversionService(repositories.conversions, repositories.commissions, repositories.affiliates, repositories.offers, transactionManager),
    commissions: new CommissionService(repositories.commissions),
    marketplace: new MarketplaceService(marketplaceRegistry, repositories.marketplaceConnections, repositories.products, repositories.affiliateAccounts, repositories.affiliateOffers),
    campaigns: new CampaignService(repositories.campaigns, repositories.campaignOffers, repositories.affiliateOffers),
    tracking: new TrackingService(repositories.trackingLinks, repositories.clicks, repositories.campaigns, repositories.affiliateOffers, repositories.campaignOffers),
    content: new ContentService(repositories.contents, repositories.campaigns, repositories.products), socialAccounts: new SocialAccountService(repositories.socialAccounts),
    socialOAuth: new SocialOAuthService(socialOAuthRegistry, repositories.socialAccounts, oauthStateRepository),
    analytics: new AnalyticsService(repositories.campaigns, repositories.trackingLinks, repositories.clicks, repositories.contents, analyticsReader),
    attribution: new ConversionAttributionService(repositories.conversions, repositories.trackingLinks, attributionRepository)
  };
}

export function createInMemoryServices(): Services {
  const repositories: RepositorySet = {
    affiliates: new InMemoryRepository<Affiliate>(), offers: new InMemoryRepository<Offer>(), conversions: new InMemoryRepository<Conversion>(), commissions: new InMemoryRepository<Commission>(),
    marketplaceConnections: new InMemoryMarketplaceConnectionRepository(), affiliateAccounts: new InMemoryAffiliateAccountRepository(), products: new InMemoryProductCatalogRepository(), affiliateOffers: new InMemoryAffiliateOfferRepository(),
    campaigns: new InMemoryRepository<Campaign>(), campaignOffers: new InMemoryCampaignOfferRepository(), trackingLinks: new InMemoryTrackingLinkRepository(), clicks: new InMemoryClickRepository(), contents: new InMemoryRepository<Content>(), socialAccounts: new InMemorySocialAccountRepository()
  };
  const transactionManager: TransactionManager = { run: (work) => work({ conversions: repositories.conversions, commissions: repositories.commissions }) };
  return createServices(repositories, transactionManager);
}
