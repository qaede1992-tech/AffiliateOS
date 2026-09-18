import { randomUUID } from "node:crypto";
import type { AffiliateAccount, AffiliateOffer, MarketplaceConnection, MarketplaceProviderInfo, MarketplaceProductInput, Product } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { AffiliateAccountRepository, AffiliateOfferRepository, MarketplaceConnectionRepository, ProductCatalogRepository } from "./repository.js";
import { MarketplaceProviderRegistry } from "./foundations.js";

const now = () => new Date().toISOString();

export class MarketplaceService {
  constructor(
    private readonly registry: MarketplaceProviderRegistry,
    private readonly connections: MarketplaceConnectionRepository,
    private readonly products: ProductCatalogRepository,
    private readonly accounts: AffiliateAccountRepository,
    private readonly offers: AffiliateOfferRepository
  ) {}

  async listProviders(): Promise<MarketplaceProviderInfo[]> {
    const configured = await this.connections.list();
    return this.registry.list().map((provider) => ({
      slug: provider.slug, displayName: provider.displayName, connectionMode: provider.connectionMode,
      configured: configured.some((connection) => connection.providerSlug === provider.slug && connection.status === "active")
    }));
  }

  async listConnections(): Promise<MarketplaceConnection[]> { return this.connections.list(); }

  async discoverProducts(connectionSlug: string): Promise<Product[]> {
    const { connection, provider } = await this.providerFor(connectionSlug);
    return Promise.all((await provider.discoverProducts()).map((input) => this.persistProduct(connection, input)));
  }
  async searchProducts(connectionSlug: string, query: string): Promise<Product[]> {
    const { connection, provider } = await this.providerFor(connectionSlug);
    return Promise.all((await provider.searchProducts(query)).map((input) => this.persistProduct(connection, input)));
  }
  async getProduct(connectionSlug: string, externalProductId: string): Promise<Product> {
    const { connection, provider } = await this.providerFor(connectionSlug);
    const input = await provider.getProduct(externalProductId);
    if (!input) throw new DomainError("PRODUCT_NOT_FOUND", "The marketplace product does not exist.", 404);
    return this.persistProduct(connection, input);
  }
  async getOffers(connectionSlug: string, externalProductId: string): Promise<AffiliateOffer[]> {
    const { connection, provider } = await this.providerFor(connectionSlug);
    const product = await this.getProduct(connectionSlug, externalProductId);
    const account = await this.accountFor(connection);
    return Promise.all((await provider.getOffers(externalProductId)).map(async (input) => {
      const existing = await this.offers.findByAccountOffer(account.id, input.externalOfferId);
      const timestamp = now();
      const offer: AffiliateOffer = {
        id: existing?.id ?? randomUUID(), productId: product.id, affiliateAccountId: account.id, externalOfferId: input.externalOfferId,
        priceCents: input.priceCents, currency: input.currency, commissionRateBps: input.commissionRateBps,
        commissionAmountCents: input.commissionAmountCents, availability: input.availability,
        availabilityMetadata: input.metadata ?? {}, affiliateUrl: existing?.affiliateUrl,
        affiliateLinkStatus: existing?.affiliateLinkStatus ?? "not_generated", status: input.availability === "out_of_stock" ? "inactive" : "active",
        createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp
      };
      return this.offers.save(offer);
    }));
  }
  async generateAffiliateLink(connectionSlug: string, externalProductId: string, externalOfferId: string): Promise<AffiliateOffer> {
    const { provider } = await this.providerFor(connectionSlug);
    const offers = await this.getOffers(connectionSlug, externalProductId);
    const offer = offers.find((item) => item.externalOfferId === externalOfferId);
    if (!offer) throw new DomainError("MARKETPLACE_OFFER_NOT_FOUND", "The marketplace offer does not exist for this product.", 404);
    const link = await provider.generateAffiliateLink(externalOfferId);
    return this.offers.save({ ...offer, affiliateUrl: link.url, affiliateLinkStatus: "active", updatedAt: now() });
  }

  private async providerFor(connectionSlug: string) {
    const connection = await this.connections.findBySlug(connectionSlug);
    if (!connection) throw new DomainError("MARKETPLACE_NOT_CONFIGURED", "The marketplace connection is not configured.", 404);
    if (connection.status !== "active") throw new DomainError("MARKETPLACE_NOT_ACTIVE", "The marketplace connection is not active.", 409);
    try { return { connection, provider: this.registry.get(connection.providerSlug) }; }
    catch { throw new DomainError("MARKETPLACE_PROVIDER_UNAVAILABLE", "The configured marketplace provider is unavailable.", 503); }
  }
  private async persistProduct(connection: MarketplaceConnection, input: MarketplaceProductInput): Promise<Product> {
    const existing = await this.products.findByMarketplaceProduct(connection.id, input.externalProductId);
    const timestamp = now();
    return this.products.save({
      id: existing?.id ?? randomUUID(), marketplaceId: connection.id, externalProductId: input.externalProductId, name: input.name,
      description: input.description, category: input.category, priceCents: input.priceCents, originalPriceCents: input.originalPriceCents,
      currency: input.currency.toUpperCase(), ratingMilli: input.ratingMilli, reviewCount: input.reviewCount ?? 0, soldCount: input.soldCount ?? 0,
      imageUrl: input.imageUrl, productUrl: input.productUrl, status: input.availability === "out_of_stock" ? "inactive" : "active",
      createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp
    });
  }
  private async accountFor(connection: MarketplaceConnection): Promise<AffiliateAccount> {
    const existing = await this.accounts.findByMarketplace(connection.id);
    if (existing) return existing;
    const timestamp = now();
    return this.accounts.save({ id: randomUUID(), marketplaceId: connection.id, name: `${connection.name} affiliate account`, status: "active", credentialReference: connection.credentialReference, configuration: {}, createdAt: timestamp, updatedAt: timestamp });
  }
}
