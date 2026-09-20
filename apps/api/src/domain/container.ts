import type { Affiliate, Campaign, Commission, Content, Conversion, Offer, SocialAccount } from "@affiliateos/shared";
import { InMemoryAffiliateAccountRepository, InMemoryAffiliateOfferRepository, InMemoryCampaignOfferRepository, InMemoryClickRepository, InMemoryConversionRepository, InMemoryMarketplaceConnectionRepository, InMemoryProductCatalogRepository, InMemoryPublicationJobRepository, InMemoryPublicationOperationRepository, InMemoryRepository, InMemorySocialAccountRepository, InMemoryTrackingLinkRepository, type RepositorySet, type TransactionManager } from "./repository.js";
import { AffiliateService, CommissionService, ConversionService, OfferService } from "./services.js";
import { MarketplaceProviderRegistry } from "./foundations.js";
import { MarketplaceService } from "./marketplace.js";
import { CampaignService, TrackingService } from "./campaigns.js";
import { ContentService, SocialAccountService } from "./content.js";
import { AnalyticsService } from "./analytics.js";
import type { AnalyticsReader } from "./analytics-db.js";
import { ConversionAttributionService, InMemoryConversionAttributionRepository, type ConversionAttributionRepository } from "./attribution.js";
import { InMemoryOAuthStateRepository, InMemorySocialOAuthProviderRegistry, SocialOAuthService, type OAuthStateRepository } from "./oauth.js";
import { CampaignOrchestrator } from "./campaign-orchestrator.js";
import { DistributionEngine, type SocialPublisher } from "./distribution-engine.js";
import { SocialPublisherRegistry } from "./social-publisher-registry.js";
import { PublicationJobService } from "./publication-job-service.js";
import { PublisherExecutor } from "./publisher-executor.js";
import { PublisherReadinessService } from "./publisher-readiness.js";
import { PublicationWorker } from "./publication-worker.js";
import { PublicationScheduler } from "./publication-scheduler.js";
import type { SocialCredentialResolver } from "./social-credentials.js";
import type { PublicationOperationRepository } from "./publication-operation.js";

export interface Services {
  affiliates: AffiliateService; offers: OfferService; conversions: ConversionService; commissions: CommissionService; marketplace: MarketplaceService;
  campaigns: CampaignService; tracking: TrackingService; content: ContentService; campaignOrchestrator: CampaignOrchestrator; distribution: DistributionEngine; socialAccounts: SocialAccountService; socialOAuth: SocialOAuthService; analytics: AnalyticsService; attribution: ConversionAttributionService;
  publicationJobs: PublicationJobService; publicationWorker: PublicationWorker; publicationScheduler: PublicationScheduler; publisherReadiness: PublisherReadinessService;
}

export function createServices(repositories: RepositorySet, transactionManager: TransactionManager, marketplaceRegistry = new MarketplaceProviderRegistry(), socialOAuthRegistry = new InMemorySocialOAuthProviderRegistry(), oauthStateRepository: OAuthStateRepository = new InMemoryOAuthStateRepository(), analyticsReader?: AnalyticsReader, attributionRepository: ConversionAttributionRepository = new InMemoryConversionAttributionRepository(), socialPublishers: SocialPublisher[] = [], socialCredentialResolver?: SocialCredentialResolver, publicationOperationRepository: PublicationOperationRepository = new InMemoryPublicationOperationRepository()): Services {
  const campaigns = new CampaignService(repositories.campaigns, repositories.campaignOffers, repositories.affiliateOffers);
  const tracking = new TrackingService(repositories.trackingLinks, repositories.clicks, repositories.campaigns, repositories.affiliateOffers, repositories.campaignOffers);
  const content = new ContentService(repositories.contents, repositories.campaigns, repositories.products);
  const publicationJobs = new PublicationJobService(repositories.publicationJobs);
  const publisherRegistry = new SocialPublisherRegistry(socialPublishers);
  const publishers = publisherRegistry.list();
  const distribution = new DistributionEngine(content, repositories.socialAccounts, publishers, publicationJobs);
  const executor = new PublisherExecutor(content, repositories.socialAccounts, publishers, socialCredentialResolver);
  const publisherReadiness = new PublisherReadinessService(publishers, Boolean(socialCredentialResolver));
  const publicationWorker = new PublicationWorker(repositories.publicationJobs, publicationJobs, executor, content, publicationOperationRepository);
  const publicationScheduler = new PublicationScheduler(publicationWorker);
  return {
    affiliates: new AffiliateService(repositories.affiliates), offers: new OfferService(repositories.offers),
    conversions: new ConversionService(repositories.conversions, repositories.commissions, repositories.affiliates, repositories.offers, transactionManager),
    commissions: new CommissionService(repositories.commissions),
    marketplace: new MarketplaceService(marketplaceRegistry, repositories.marketplaceConnections, repositories.products, repositories.affiliateAccounts, repositories.affiliateOffers),
    campaigns, tracking, content, campaignOrchestrator: new CampaignOrchestrator(campaigns, tracking, content),
    distribution,
    socialAccounts: new SocialAccountService(repositories.socialAccounts),
    socialOAuth: new SocialOAuthService(socialOAuthRegistry, repositories.socialAccounts, oauthStateRepository),
    analytics: new AnalyticsService(repositories.campaigns, repositories.trackingLinks, repositories.clicks, repositories.contents, analyticsReader, repositories.conversions, repositories.commissions, attributionRepository),
    attribution: new ConversionAttributionService(repositories.conversions, repositories.trackingLinks, attributionRepository),
    publicationJobs, publicationWorker, publicationScheduler, publisherReadiness
  };
}

export function createInMemoryServices(): Services {
  const repositories: RepositorySet = {
    affiliates: new InMemoryRepository<Affiliate>(), offers: new InMemoryRepository<Offer>(), conversions: new InMemoryConversionRepository(), commissions: new InMemoryRepository<Commission>(),
    marketplaceConnections: new InMemoryMarketplaceConnectionRepository(), affiliateAccounts: new InMemoryAffiliateAccountRepository(), products: new InMemoryProductCatalogRepository(), affiliateOffers: new InMemoryAffiliateOfferRepository(),
    campaigns: new InMemoryRepository<Campaign>(), campaignOffers: new InMemoryCampaignOfferRepository(), trackingLinks: new InMemoryTrackingLinkRepository(), clicks: new InMemoryClickRepository(), contents: new InMemoryRepository<Content>(), socialAccounts: new InMemorySocialAccountRepository(), publicationJobs: new InMemoryPublicationJobRepository()
  };
  const transactionManager: TransactionManager = { run: (work) => work({ conversions: repositories.conversions, commissions: repositories.commissions }) };
  return createServices(repositories, transactionManager);
}
