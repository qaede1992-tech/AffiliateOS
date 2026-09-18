import type { EntityId } from "@affiliateos/shared";

export interface Repository<T extends { id: EntityId }> {
  list(): Promise<T[]>;
  findById(id: EntityId): Promise<T | undefined>;
  save(entity: T): Promise<T>;
}

export class InMemoryRepository<T extends { id: EntityId }> implements Repository<T> {
  private readonly entities = new Map<EntityId, T>();

  async list(): Promise<T[]> {
    return [...this.entities.values()];
  }

  async findById(id: EntityId): Promise<T | undefined> {
    return this.entities.get(id);
  }

  async save(entity: T): Promise<T> {
    this.entities.set(entity.id, entity);
    return entity;
  }
}

export class InMemoryMarketplaceConnectionRepository extends InMemoryRepository<import("@affiliateos/shared").MarketplaceConnection> implements MarketplaceConnectionRepository {
  async findBySlug(slug: string) { return (await this.list()).find((connection) => connection.slug === slug); }
}
export class InMemoryProductCatalogRepository extends InMemoryRepository<import("@affiliateos/shared").Product> implements ProductCatalogRepository {
  async findByMarketplaceProduct(marketplaceId: string, externalProductId: string) { return (await this.list()).find((product) => product.marketplaceId === marketplaceId && product.externalProductId === externalProductId); }
}
export class InMemoryAffiliateOfferRepository extends InMemoryRepository<import("@affiliateos/shared").AffiliateOffer> implements AffiliateOfferRepository {
  async findByAccountOffer(affiliateAccountId: string, externalOfferId: string) { return (await this.list()).find((offer) => offer.affiliateAccountId === affiliateAccountId && offer.externalOfferId === externalOfferId); }
}
export class InMemoryAffiliateAccountRepository extends InMemoryRepository<import("@affiliateos/shared").AffiliateAccount> implements AffiliateAccountRepository {
  async findByMarketplace(marketplaceId: string) { return (await this.list()).find((account) => account.marketplaceId === marketplaceId); }
}

export interface RepositorySet {
  affiliates: Repository<import("@affiliateos/shared").Affiliate>;
  offers: Repository<import("@affiliateos/shared").Offer>;
  conversions: Repository<import("@affiliateos/shared").Conversion>;
  commissions: Repository<import("@affiliateos/shared").Commission>;
  marketplaceConnections: MarketplaceConnectionRepository;
  affiliateAccounts: AffiliateAccountRepository;
  products: ProductCatalogRepository;
  affiliateOffers: AffiliateOfferRepository;
}

export interface MarketplaceConnectionRepository extends Repository<import("@affiliateos/shared").MarketplaceConnection> {
  findBySlug(slug: string): Promise<import("@affiliateos/shared").MarketplaceConnection | undefined>;
}
export interface ProductCatalogRepository extends Repository<import("@affiliateos/shared").Product> {
  findByMarketplaceProduct(marketplaceId: EntityId, externalProductId: string): Promise<import("@affiliateos/shared").Product | undefined>;
}
export interface AffiliateAccountRepository extends Repository<import("@affiliateos/shared").AffiliateAccount> {
  findByMarketplace(marketplaceId: EntityId): Promise<import("@affiliateos/shared").AffiliateAccount | undefined>;
}
export interface AffiliateOfferRepository extends Repository<import("@affiliateos/shared").AffiliateOffer> {
  findByAccountOffer(affiliateAccountId: EntityId, externalOfferId: string): Promise<import("@affiliateos/shared").AffiliateOffer | undefined>;
}

export interface TransactionManager {
  run<T>(work: (repositories: Pick<RepositorySet, "conversions" | "commissions">) => Promise<T>): Promise<T>;
}
