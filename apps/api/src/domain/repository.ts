import type { EntityId } from "@affiliateos/shared";
import type { Affiliate, Campaign, CampaignOffer, Click, Commission, Content, Conversion, Offer, TrackingLink, SocialAccount } from "@affiliateos/shared";
import type { PublicationJob } from "./publication-job.js";

export interface Repository<T extends { id: EntityId }> { list(): Promise<T[]>; findById(id: EntityId): Promise<T | undefined>; save(entity: T): Promise<T>; }
export class InMemoryRepository<T extends { id: EntityId }> {
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
export class InMemoryConversionRepository extends InMemoryRepository<Conversion> implements ConversionRepository {
  async findByIdempotencyKey(idempotencyKey: string) { return (await this.list()).find((conversion) => conversion.idempotencyKey === idempotencyKey); }
}
export class InMemoryTrackingLinkRepository extends InMemoryRepository<TrackingLink> implements TrackingLinkRepository { async findByCode(code: string) { return (await this.list()).find((link) => link.code === code); } async listByCampaign(campaignId: EntityId) { return (await this.list()).filter((link) => link.campaignId === campaignId); } }
export class InMemorySocialAccountRepository extends InMemoryRepository<SocialAccount> implements SocialAccountRepository { async findByPlatformAccount(platform: string, accountReference: string) { return (await this.list()).find((account) => account.platform === platform && account.accountReference === accountReference); } }
export class InMemoryPublicationJobRepository implements PublicationJobRepository {
  private readonly jobs = new Map<EntityId, PublicationJob>();
  async list() { return [...this.jobs.values()]; }
  async findById(id: EntityId) { return this.jobs.get(id); }
  async findByIdempotencyKey(key: string) { return [...this.jobs.values()].find((job) => job.idempotencyKey === key); }
  async save(job: PublicationJob) { this.jobs.set(job.id, job); return job; }
  async claimDue(id: EntityId, nowDate: Date, lockTimeoutMs: number) {
    const job = this.jobs.get(id);
    if (!job || job.status === "succeeded") return undefined;
    const scheduled = new Date(job.scheduledAt).getTime();
    const locked = job.lockedAt ? new Date(job.lockedAt).getTime() : undefined;
    const lockFresh = locked !== undefined && nowDate.getTime() - locked < lockTimeoutMs;
    if (scheduled > nowDate.getTime() || lockFresh) return undefined;
    const claimed: PublicationJob = { ...job, status: "processing", attemptCount: job.attemptCount + 1, lockedAt: nowDate.toISOString(), updatedAt: nowDate.toISOString() };
    this.jobs.set(id, claimed);
    return claimed;
  }
}
export interface RepositorySet {
  affiliates: Repository<Affiliate>; offers: Repository<Offer>; conversions: ConversionRepository; commissions: Repository<Commission>;
  marketplaceConnections: MarketplaceConnectionRepository; affiliateAccounts: AffiliateAccountRepository; products: ProductCatalogRepository; affiliateOffers: AffiliateOfferRepository;
  campaigns: Repository<Campaign>; campaignOffers: CampaignOfferRepository; trackingLinks: TrackingLinkRepository; clicks: ClickRepository;
  contents: Repository<Content>; socialAccounts: SocialAccountRepository; publicationJobs: PublicationJobRepository;
}
export interface ConversionRepository extends Repository<Conversion> { findByIdempotencyKey(idempotencyKey: string): Promise<Conversion | undefined>; }
export interface MarketplaceConnectionRepository extends Repository<import("@affiliateos/shared").MarketplaceConnection> { findBySlug(slug: string): Promise<import("@affiliateos/shared").MarketplaceConnection | undefined>; }
export interface ProductCatalogRepository extends Repository<import("@affiliateos/shared").Product> { findByMarketplaceProduct(marketplaceId: EntityId, externalProductId: string): Promise<import("@affiliateos/shared").Product | undefined>; }
export interface AffiliateAccountRepository extends Repository<import("@affiliateos/shared").AffiliateAccount> { findByMarketplace(marketplaceId: EntityId): Promise<import("@affiliateos/shared").AffiliateAccount | undefined>; }
export interface AffiliateOfferRepository extends Repository<import("@affiliateos/shared").AffiliateOffer> { findByAccountOffer(affiliateAccountId: EntityId, externalOfferId: string): Promise<import("@affiliateos/shared").AffiliateOffer | undefined>; }
export interface CampaignOfferRepository { listByCampaign(campaignId: EntityId): Promise<CampaignOffer[]>; find(campaignId: EntityId, affiliateOfferId: EntityId): Promise<CampaignOffer | undefined>; save(entity: CampaignOffer): Promise<CampaignOffer>; remove(campaignId: EntityId, affiliateOfferId: EntityId): Promise<void>; }
export interface TrackingLinkRepository extends Repository<TrackingLink> { findByCode(code: string): Promise<TrackingLink | undefined>; listByCampaign(campaignId: EntityId): Promise<TrackingLink[]>; }
export interface ClickRepository extends Repository<Click> { listByTrackingLink(trackingLinkId: EntityId): Promise<Click[]>; findByIdempotencyKey(trackingLinkId: EntityId, idempotencyKey: string): Promise<Click | undefined>; countByTrackingLink(trackingLinkId: EntityId): Promise<number>; }
export interface SocialAccountRepository extends Repository<SocialAccount> { findByPlatformAccount(platform: string, accountReference: string): Promise<SocialAccount | undefined>; }
export interface PublicationJobRepository extends Repository<PublicationJob> { findByIdempotencyKey(key: string): Promise<PublicationJob | undefined>; claimDue?(id: EntityId, now: Date, lockTimeoutMs: number): Promise<PublicationJob | undefined>; }
export interface TransactionManager { run<T>(work: (repositories: Pick<RepositorySet, "conversions" | "commissions">) => Promise<T>): Promise<T>; }