import type { EntityId } from "@affiliateos/shared";
import type { Campaign, CampaignOffer, Click, TrackingLink } from "@affiliateos/shared";

export interface Repository<T extends { id: EntityId }> { list(): Promise<T[]>; findById(id: EntityId): Promise<T | undefined>; save(entity: T): Promise<T>; }
export class InMemoryRepository<T extends { id: EntityId }> implements Repository<T> {
  private readonly entities = new Map<EntityId, T>();
  async list(): Promise<T[]> { return [...this.entities.values()]; }
  async findById(id: EntityId): Promise<T | undefined> { return this.entities.get(id); }
  async save(entity: T): Promise<T> { this.entities.set(entity.id, entity); return entity; }
}
export class InMemoryMarketplaceConnectionRepository extends InMemoryRepository<import("@affiliateos/shared").MarketplaceConnection> implements MarketplaceConnectionRepository { async findBySlug(slug: string) { return (await this.list()).find((connection) => connection.slug === slug); } }
export class InMemoryProductCatalogRepository extends InMemoryRepository<import("@affiliateos/shared").Product> implements ProductCatalogRepository { async findByMarketplaceProduct(marketplaceId: string, externalProductId: string) { return (await this.list()).find((product) => product.marketplaceId === marketplaceId && product.externalProductId === externalProductId); } }
export class InMemoryAffiliateOfferRepository extends InMemoryRepository<import("@affiliateos/shared").AffiliateOffer> implements AffiliateOfferRepository { async findByAccountOffer(affiliateAccountId: string, externalOfferId: string) { return (await this.list()).find((offer) => offer.affiliateAccountId === affiliateAccountId && offer.externalOfferId === externalOfferId); } }
export class InMemoryAffiliateAccountRepository extends InMemoryRepository<import("@affiliateos/shared").AffiliateAccount> implements AffiliateAccountRepository { async findByMarketplace(marketplaceId: string) { return (await this.list()).find((account) => account.marketplaceId === marketplaceId); } }
export class InMemoryCampaignOfferRepository implements CampaignOfferRepository {
  private readonly entities = new Map<string, CampaignOffer>();
  async listByCampaign(campaignId: EntityId) { return [...this.entities.values()].filter((item) => item.campaignId === campaignId); }
  async find(campaignId: EntityId, affiliateOfferId: EntityId) { return this.entities.get(`${campaignId}:${affiliateOfferId}`); }
  async save(entity: CampaignOffer) { this.entities.set(`${entity.campaignId}:${entity.affiliateOfferId}`, entity); return entity; }
  async remove(campaignId: EntityId, affiliateOfferId: EntityId) { this.entities.delete(`${campaignId}:${affiliateOfferId}`); }
}
export class InMemoryClickRepository extends InMemoryRepository<Click> implements ClickRepository {
  async listByTrackingLink(trackingLinkId: EntityId) { return (await this.list()).filter((click) => click.trackingLinkId === trackingLinkId); }
  async findByIdempotencyKey(trackingLinkId: EntityId, idempotencyKey: string) { return (await this.listByTrackingLink(trackingLinkId)).find((click) => click.idempotencyKey === idempotencyKey); }
  async countByTrackingLink(trackingLinkId: EntityId) { return (await this.listByTrackingLink(trackingLinkId)).length; }
}
export class InMemoryTrackingLinkRepository extends InMemoryRepository<TrackingLink> implements TrackingLinkRepository { async findByCode(code: string) { return (await this.list()).find((link) => link.code === code); } async listByCampaign(campaignId: EntityId) { return (await this.list()).filter((link) => link.campaignId === campaignId); } }
export interface RepositorySet {
  affiliates: Repository<import("@affiliateos/shared").Affiliate>; offers: Repository<import("@affiliateos/shared").Offer>; conversions: Repository<import("@affiliateos/shared").Conversion>; commissions: Repository<import("@affiliateos/shared").Commission>;
  marketplaceConnections: MarketplaceConnectionRepository; affiliateAccounts: AffiliateAccountRepository; products: ProductCatalogRepository; affiliateOffers: AffiliateOfferRepository;
  campaigns: Repository<Campaign>; campaignOffers: CampaignOfferRepository; trackingLinks: TrackingLinkRepository; clicks: ClickRepository;
}
export interface MarketplaceConnectionRepository extends Repository<import("@affiliateos/shared").MarketplaceConnection> { findBySlug(slug: string): Promise<import("@affiliateos/shared").MarketplaceConnection | undefined>; }
export interface ProductCatalogRepository extends Repository<import("@affiliateos/shared").Product> { findByMarketplaceProduct(marketplaceId: EntityId, externalProductId: string): Promise<import("@affiliateos/shared").Product | undefined>; }
export interface AffiliateAccountRepository extends Repository<import("@affiliateos/shared").AffiliateAccount> { findByMarketplace(marketplaceId: EntityId): Promise<import("@affiliateos/shared").AffiliateAccount | undefined>; }
export interface AffiliateOfferRepository extends Repository<import("@affiliateos/shared").AffiliateOffer> { findByAccountOffer(affiliateAccountId: EntityId, externalOfferId: string): Promise<import("@affiliateos/shared").AffiliateOffer | undefined>; }
export interface CampaignOfferRepository { listByCampaign(campaignId: EntityId): Promise<CampaignOffer[]>; find(campaignId: EntityId, affiliateOfferId: EntityId): Promise<CampaignOffer | undefined>; save(entity: CampaignOffer): Promise<CampaignOffer>; remove(campaignId: EntityId, affiliateOfferId: EntityId): Promise<void>; }
export interface TrackingLinkRepository extends Repository<TrackingLink> { findByCode(code: string): Promise<TrackingLink | undefined>; listByCampaign(campaignId: EntityId): Promise<TrackingLink[]>; }
export interface ClickRepository extends Repository<Click> { listByTrackingLink(trackingLinkId: EntityId): Promise<Click[]>; findByIdempotencyKey(trackingLinkId: EntityId, idempotencyKey: string): Promise<Click | undefined>; countByTrackingLink(trackingLinkId: EntityId): Promise<number>; }
export interface TransactionManager { run<T>(work: (repositories: Pick<RepositorySet, "conversions" | "commissions">) => Promise<T>): Promise<T>; }
