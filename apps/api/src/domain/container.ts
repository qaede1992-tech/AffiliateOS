import type { Affiliate, Campaign, Content, Conversion, Offer, SocialAccount } from "@affiliateos/shared";
import { InMemoryAffiliateAccountRepository, InMemoryAffiliateOfferRepository, InMemoryCampaignOfferRepository, InMemoryClickRepository, InMemoryCommissionRepository, InMemoryConversionRepository, InMemoryMarketplaceConnectionRepository, InMemoryMediaAssetRepository, InMemoryProductCatalogRepository, InMemoryPublicationJobRepository, InMemoryPublicationOperationRepository, InMemoryRepository, InMemorySocialAccountRepository, InMemoryTrackingLinkRepository, type RepositorySet, type TransactionManager } from "./repository.js";
import { AffiliateService, CommissionService, ConversionService, OfferService } from "./services.js";
import { MarketplaceProviderRegistry } from "./foundations.js";
import { MarketplaceService } from "./marketplace.js";
import { ShopeeConversionSyncService } from "./shopee-conversion-sync.js";
import { ShopeeConversionSyncScheduler } from "./shopee-conversion-sync-scheduler.js";
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
import { AutonomousRunService } from "./autonomous-run-service.js";
import { AutonomousExecutionService } from "./autonomous-execution.js";
import { AutonomousOpportunitySelector, type OpportunitySelectionPolicy, type OpportunitySelectionPoliciesByMarketplace } from "./autonomous-opportunity.js";
import { InMemoryAutonomousRunRepository, type AutonomousRunRepository } from "./autonomous-run.js";
import type { PublicationOperationRepository } from "./publication-operation.js";
import { AutonomousCycleService } from "./autonomous-cycle.js";
import { AutonomousMarketplaceCandidateProvider } from "./autonomous-marketplace-candidates.js";
import { AutonomousScheduler } from "./autonomous-scheduler.js";
import { AutonomousAnalyticsFeedbackProvider } from "./autonomous-feedback.js";
import { InMemoryAutonomousFeedbackMemoryRepository, type AutonomousFeedbackMemoryRepository } from "./autonomous-feedback-memory.js";
import { ProviderConversionProcessor } from "./provider-conversion-processor.js";
import { InMemoryAutonomousCycleLock, type AutonomousCycleLock } from "./autonomous-cycle-lock.js";
import { AutonomousCampaignActionExecutor } from "./autonomous-campaign-action-executor.js";
import { AutonomousOptimizationRunner } from "./autonomous-optimization-runner.js";
import { InMemoryOptimizationStateStore, type OptimizationStateReader, type OptimizationStateWriter } from "./autonomous-optimization.js";
import type { AutonomousDecisionAuditRepository, AutonomousDecisionAuditReader } from "./autonomous-decision-audit.js";
import type { AutonomousActionOutcomeWriter } from "./autonomous-action-outcome.js";
import { AutonomousExplorationEvaluationRunner } from "./autonomous-exploration-evaluation-runner.js";
import { AdaptiveExplorationPolicyProvider, type AdaptiveExplorationPolicy } from "./adaptive-exploration-policy.js";
import type { AutonomousExplorationStateRepository } from "./autonomous-exploration-state.js";

export interface Services {
  affiliates: AffiliateService; offers: OfferService; conversions: ConversionService; commissions: CommissionService; marketplace: MarketplaceService; shopeeConversionSync: ShopeeConversionSyncService; shopeeConversionSyncScheduler: ShopeeConversionSyncScheduler;
  campaigns: CampaignService; tracking: TrackingService; content: ContentService; autonomousDecisionAudits?: AutonomousDecisionAuditReader; campaignOrchestrator: CampaignOrchestrator; autonomousExecution: AutonomousExecutionService; autonomousRuns: AutonomousRunService; autonomousCycle: AutonomousCycleService; autonomousScheduler: AutonomousScheduler; autonomousOptimization: AutonomousOptimizationRunner; distribution: DistributionEngine; socialAccounts: SocialAccountService; socialOAuth: SocialOAuthService; analytics: AnalyticsService; attribution: ConversionAttributionService;
  publicationJobs: PublicationJobService; publicationWorker: PublicationWorker; publicationScheduler: PublicationScheduler; publisherReadiness: PublisherReadinessService; providerConversions: ProviderConversionProcessor;
}

export function createServices(repositories: RepositorySet, transactionManager: TransactionManager, marketplaceRegistry = new MarketplaceProviderRegistry(), socialOAuthRegistry = new InMemorySocialOAuthProviderRegistry(), oauthStateRepository: OAuthStateRepository = new InMemoryOAuthStateRepository(), analyticsReader?: AnalyticsReader, attributionRepository: ConversionAttributionRepository = new InMemoryConversionAttributionRepository(), socialPublishers: SocialPublisher[] = [], socialCredentialResolver?: SocialCredentialResolver, publicationOperationRepository: PublicationOperationRepository = repositories.publicationOperations ?? new InMemoryPublicationOperationRepository(), autonomousRunRepository: AutonomousRunRepository = repositories.autonomousRuns ?? new InMemoryAutonomousRunRepository(), autonomousSchedulerIntervalMs?: number, shopeeConversionSyncSchedulerIntervalMs?: number, shopeeConversionSyncLookbackHours?: number, autonomousFeedbackMemoryRepository: AutonomousFeedbackMemoryRepository = new InMemoryAutonomousFeedbackMemoryRepository(), autonomousCycleLock?: AutonomousCycleLock, optimizationStateReader?: OptimizationStateReader, optimizationStateWriter?: OptimizationStateWriter, autonomousSelectionPolicy: OpportunitySelectionPolicy = {}, autonomousMarketplacePolicies: OpportunitySelectionPoliciesByMarketplace = {}, autonomousDecisionAuditRepository?: AutonomousDecisionAuditRepository, autonomousActionOutcomeWriter?: AutonomousActionOutcomeWriter, autonomousOptimizationPolicy: import("./optimization-engine.js").OptimizationPolicy = {}, explorationEvaluationPolicy: import("./exploration-evaluator.js").ExplorationEvaluationPolicy = {}, adaptiveExplorationPolicy: AdaptiveExplorationPolicy = {}, autonomousExplorationStateRepository?: AutonomousExplorationStateRepository): Services {
  if (Boolean(optimizationStateReader) !== Boolean(optimizationStateWriter)) {
    throw new Error("Optimization state reader and writer must be supplied together.");
  }
  const conversions = new ConversionService(repositories.conversions, repositories.commissions, repositories.affiliates, repositories.offers, transactionManager);
  const campaigns = new CampaignService(repositories.campaigns, repositories.campaignOffers, repositories.affiliateOffers);
  const tracking = new TrackingService(repositories.trackingLinks, repositories.clicks, repositories.campaigns, repositories.affiliateOffers, repositories.campaignOffers);
  const content = new ContentService(repositories.contents, repositories.campaigns, repositories.products);
  const publicationJobs = new PublicationJobService(repositories.publicationJobs);
  const publisherRegistry = new SocialPublisherRegistry(socialPublishers);
  const publishers = publisherRegistry.list();
  const distribution = new DistributionEngine(content, repositories.socialAccounts, publishers, publicationJobs);
  const executor = new PublisherExecutor(content, repositories.socialAccounts, publishers, socialCredentialResolver, repositories.mediaAssets);
  const publisherReadiness = new PublisherReadinessService(publishers, Boolean(socialCredentialResolver), repositories.socialAccounts);
  const publicationWorker = new PublicationWorker(repositories.publicationJobs, publicationJobs, executor, content, publicationOperationRepository);
  const publicationScheduler = new PublicationScheduler(publicationWorker);
  const autonomousRuns = new AutonomousRunService(autonomousRunRepository);
  const analytics = new AnalyticsService(repositories.campaigns, repositories.trackingLinks, repositories.clicks, repositories.contents, analyticsReader, repositories.conversions, repositories.commissions, attributionRepository);
  const feedback = new AutonomousAnalyticsFeedbackProvider(analytics, autonomousFeedbackMemoryRepository);
  const campaignOrchestrator = new CampaignOrchestrator(campaigns, tracking, content, undefined, distribution, autonomousRuns, repositories.mediaAssets);
  const marketplace = new MarketplaceService(marketplaceRegistry, repositories.marketplaceConnections, repositories.products, repositories.affiliateAccounts, repositories.affiliates, repositories.affiliateOffers, repositories.offers);
  const attribution = new ConversionAttributionService(repositories.conversions, repositories.trackingLinks, attributionRepository);
  const providerConversions = new ProviderConversionProcessor(conversions, {
    async resolveAffiliate(reference) { return (await repositories.affiliates.findById(reference))?.id; },
    async resolveOffer(reference: string) { return (await repositories.offers.findById(reference))?.id; },
    async resolveTracking(accountScope: string, reference: string) {
      const link = await repositories.trackingLinks.findByCode(reference);
      if (!link) return undefined;
      const account = await repositories.affiliateAccounts.findById(accountScope);
      const affiliateOffer = await repositories.affiliateOffers.findById(link.affiliateOfferId);
      if (!account?.affiliateId || !affiliateOffer || affiliateOffer.affiliateAccountId !== account.id || !affiliateOffer.conversionOfferId) return undefined;
      const conversionOffer = await repositories.offers.findById(affiliateOffer.conversionOfferId);
      if (!conversionOffer || conversionOffer.status !== "active") return undefined;
      return { affiliateId: account.affiliateId, offerId: conversionOffer.id, affiliateOfferId: affiliateOffer.id, trackingLinkId: link.id };
    }
  }, {
    async attribute(conversionId, trackingLinkId) {
      await attribution.create(conversionId, { trackingLinkId }, { allowInactiveTrackingLink: true });
    }
  });
  const shopeeConversionSync = new ShopeeConversionSyncService(marketplace, conversions, providerConversions);
  const shopeeConversionSyncScheduler = new ShopeeConversionSyncScheduler(marketplace, shopeeConversionSync, autonomousCycleLock ?? new InMemoryAutonomousCycleLock(), { intervalMs: shopeeConversionSyncSchedulerIntervalMs, lookbackHours: shopeeConversionSyncLookbackHours });
  const candidateProvider = new AutonomousMarketplaceCandidateProvider(marketplace);
  const defaultOptimizationState = new InMemoryOptimizationStateStore();
  const stateReader = optimizationStateReader ?? defaultOptimizationState;
  const stateWriter = optimizationStateWriter ?? defaultOptimizationState;
  const autonomousOptimization = new AutonomousOptimizationRunner(analytics, stateReader, stateWriter, new AutonomousCampaignActionExecutor(campaigns, content, distribution, autonomousActionOutcomeWriter), autonomousActionOutcomeWriter, autonomousOptimizationPolicy, 24 * 60 * 60_000, feedback);
  const explorationEvaluation = autonomousDecisionAuditRepository ? new AutonomousExplorationEvaluationRunner(autonomousDecisionAuditRepository, autonomousDecisionAuditRepository, explorationEvaluationPolicy) : undefined;
  const adaptiveExploration = autonomousDecisionAuditRepository ? new AdaptiveExplorationPolicyProvider(autonomousDecisionAuditRepository, adaptiveExplorationPolicy, autonomousExplorationStateRepository) : undefined;
  const autonomousExecution = new AutonomousExecutionService(new AutonomousOpportunitySelector(), campaignOrchestrator, feedback, autonomousRuns, autonomousDecisionAuditRepository, adaptiveExploration);
  const autonomousCycle = new AutonomousCycleService(candidateProvider, autonomousExecution, autonomousCycleLock, "affiliateos:autonomous-cycle", autonomousOptimization, explorationEvaluation);
  const autonomousScheduler = new AutonomousScheduler(autonomousCycle, { policy: autonomousSelectionPolicy, policiesByMarketplace: autonomousMarketplacePolicies }, { intervalMs: autonomousSchedulerIntervalMs });
  return {
    affiliates: new AffiliateService(repositories.affiliates), offers: new OfferService(repositories.offers), conversions, commissions: new CommissionService(repositories.commissions), marketplace, campaigns, tracking, content, campaignOrchestrator, autonomousExecution, autonomousRuns, autonomousCycle, autonomousScheduler, autonomousOptimization, distribution,
    shopeeConversionSync, shopeeConversionSyncScheduler, autonomousDecisionAudits: autonomousDecisionAuditRepository,
    socialAccounts: new SocialAccountService(repositories.socialAccounts), socialOAuth: new SocialOAuthService(socialOAuthRegistry, repositories.socialAccounts, oauthStateRepository), analytics, attribution, publicationJobs, publicationWorker, publicationScheduler, publisherReadiness, providerConversions
  };
}

export function createInMemoryServices(): Services {
  const repositories: RepositorySet = {
    affiliates: new InMemoryRepository<Affiliate>(), offers: new InMemoryRepository<Offer>(), conversions: new InMemoryConversionRepository(), commissions: new InMemoryCommissionRepository(), marketplaceConnections: new InMemoryMarketplaceConnectionRepository(), affiliateAccounts: new InMemoryAffiliateAccountRepository(), products: new InMemoryProductCatalogRepository(), affiliateOffers: new InMemoryAffiliateOfferRepository(), campaigns: new InMemoryRepository<Campaign>(), campaignOffers: new InMemoryCampaignOfferRepository(), trackingLinks: new InMemoryTrackingLinkRepository(), clicks: new InMemoryClickRepository(), contents: new InMemoryRepository<Content>(), mediaAssets: new InMemoryMediaAssetRepository(), socialAccounts: new InMemorySocialAccountRepository(), publicationJobs: new InMemoryPublicationJobRepository(), publicationOperations: new InMemoryPublicationOperationRepository(), autonomousRuns: new InMemoryAutonomousRunRepository()
  };
  const transactionManager: TransactionManager = { run: (work) => work({ conversions: repositories.conversions, commissions: repositories.commissions }) };
  return createServices(repositories, transactionManager);
}
