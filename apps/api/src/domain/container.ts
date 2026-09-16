import type { Affiliate, Commission, Conversion, Offer } from "@affiliateos/shared";
import { InMemoryRepository, type RepositorySet, type TransactionManager } from "./repository.js";
import { AffiliateService, CommissionService, ConversionService, OfferService } from "./services.js";

export interface Services {
  affiliates: AffiliateService;
  offers: OfferService;
  conversions: ConversionService;
  commissions: CommissionService;
}

export function createServices(repositories: RepositorySet, transactionManager: TransactionManager): Services {
  return {
    affiliates: new AffiliateService(repositories.affiliates),
    offers: new OfferService(repositories.offers),
    conversions: new ConversionService(
      repositories.conversions,
      repositories.commissions,
      repositories.affiliates,
      repositories.offers,
      transactionManager
    ),
    commissions: new CommissionService(repositories.commissions)
  };
}

export function createInMemoryServices(): Services {
  const repositories: RepositorySet = {
    affiliates: new InMemoryRepository<Affiliate>(),
    offers: new InMemoryRepository<Offer>(),
    conversions: new InMemoryRepository<Conversion>(),
    commissions: new InMemoryRepository<Commission>()
  };
  const transactionManager: TransactionManager = {
    run: (work) => work({ conversions: repositories.conversions, commissions: repositories.commissions })
  };
  return createServices(repositories, transactionManager);
}