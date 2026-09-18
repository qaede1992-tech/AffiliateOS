import { randomUUID } from "node:crypto";
import type { AffiliateAccount, AffiliateOffer, CreateMarketplaceConnectionRequest, MarketplaceConnection, MarketplaceConnectionView, MarketplaceProviderInfo, MarketplaceProductInput, Product, UpdateMarketplaceConnectionRequest } from "@affiliateos/shared";
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
      configured: configured.some((connection) => connection.providerSlug === provider.slug), capabilities: [...provider.capabilities], supportsConnectionTest: Boolean(provider.testConnection)
    }));
  }

  async listConnections(): Promise<MarketplaceConnectionView[]> { return (await this.connections.list()).map(this.toView); }
  async getConnection(slug: string): Promise<MarketplaceConnectionView> { return this.toView(await this.connectionFor(slug)); }
  async createConnection(input: CreateMarketplaceConnectionRequest): Promise<MarketplaceConnectionView> {
    if (await this.connections.findBySlug(input.slug)) throw new DomainError("MARKETPLACE_CONNECTION_EXISTS", "A marketplace connection already uses this slug.", 409);
    const provider = this.getProvider(input.providerSlug);
    this.validate(provider, input.configuration ?? {}, input.credentialReference);
    const timestamp = now();
    const connection: MarketplaceConnection = { id: randomUUID(), name: input.name, slug: input.slug, providerSlug: provider.slug, connectionMode: provider.connectionMode, status: "pending", enabled: input.enabled ?? false, credentialReference: input.credentialReference, configuration: input.configuration ?? {}, healthStatus: provider.testConnection ? "unverified" : "unsupported", healthMetadata: {}, createdAt: timestamp, updatedAt: timestamp };
    return this.toView(await this.connections.save(connection));
  }
  async updateConnection(slug: string, input: UpdateMarketplaceConnectionRequest): Promise<MarketplaceConnectionView> {
    const connection = await this.connectionFor(slug); const provider = this.getProvider(connection.providerSlug);
    const configuration = input.configuration ?? connection.configuration;
    const credentialReference = input.credentialReference ?? connection.credentialReference;
    this.validate(provider, configuration, credentialReference);
    return this.toView(await this.connections.save({ ...connection, name: input.name ?? connection.name, configuration, credentialReference, healthStatus: provider.testConnection ? "unverified" : "unsupported", healthError: undefined, healthMetadata: {}, lastCheckedAt: undefined, lastSuccessfulCheckAt: undefined, updatedAt: now() }));
  }
  async setEnabled(slug: string, enabled: boolean): Promise<MarketplaceConnectionView> {
    const connection = await this.connectionFor(slug);
    const status: MarketplaceConnection["status"] = enabled ? (connection.healthStatus === "healthy" || connection.connectionMode === "mock" ? "active" : "pending") : "inactive";
    return this.toView(await this.connections.save({ ...connection, enabled, status, updatedAt: now() }));
  }
  async testConnection(slug: string): Promise<MarketplaceConnectionView> {
    const connection = await this.connectionFor(slug); const provider = this.getProvider(connection.providerSlug); const checkedAt = now();
    if (!provider.testConnection) throw new DomainError("MARKETPLACE_TEST_UNSUPPORTED", "This marketplace provider does not support connection testing.", 409);
    try {
      const result = await provider.testConnection({ credentialReference: connection.credentialReference, configuration: connection.configuration });
      const status: MarketplaceConnection["status"] = connection.enabled ? "active" : "inactive";
      return this.toView(await this.connections.save({ ...connection, status, healthStatus: "healthy", healthError: undefined, healthMetadata: result.metadata ?? {}, lastCheckedAt: checkedAt, lastSuccessfulCheckAt: checkedAt, updatedAt: checkedAt }));
    } catch (error) {
      const message = safeErrorMessage(error);
      return this.toView(await this.connections.save({ ...connection, status: "error", healthStatus: "unhealthy", healthError: message, healthMetadata: {}, lastCheckedAt: checkedAt, updatedAt: checkedAt }));
    }
  }

  async discoverProducts(connectionSlug: string): Promise<Product[]> {
    const { connection, provider } = await this.providerFor(connectionSlug);
    return Promise.all((await this.requireCapability<() => Promise<MarketplaceProductInput[]>>(provider, "discoverProducts")()).map((input) => this.persistProduct(connection, input)));
  }
  async searchProducts(connectionSlug: string, query: string): Promise<Product[]> {
    const { connection, provider } = await this.providerFor(connectionSlug);
    return Promise.all((await this.requireCapability<(query: string) => Promise<MarketplaceProductInput[]>>(provider, "searchProducts")(query)).map((input) => this.persistProduct(connection, input)));
  }
  async getProduct(connectionSlug: string, externalProductId: string): Promise<Product> {
    const { connection, provider } = await this.providerFor(connectionSlug);
    const input = await this.requireCapability<(id: string) => Promise<MarketplaceProductInput | undefined>>(provider, "getProduct")(externalProductId);
    if (!input) throw new DomainError("PRODUCT_NOT_FOUND", "The marketplace product does not exist.", 404);
    return this.persistProduct(connection, input);
  }
  async getOffers(connectionSlug: string, externalProductId: string): Promise<AffiliateOffer[]> {
    const { connection, provider } = await this.providerFor(connectionSlug);
    const product = await this.getProduct(connectionSlug, externalProductId);
    const account = await this.accountFor(connection);
    return Promise.all((await this.requireCapability<(id: string) => Promise<import("@affiliateos/shared").MarketplaceOfferInput[]>>(provider, "getOffers")(externalProductId)).map(async (input) => {
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
    const link = await this.requireCapability<(id: string) => Promise<{ url: string; expiresAt?: string }>>(provider, "generateAffiliateLink")(externalOfferId);
    return this.offers.save({ ...offer, affiliateUrl: link.url, affiliateLinkStatus: "active", updatedAt: now() });
  }

  private async providerFor(connectionSlug: string) {
    const connection = await this.connections.findBySlug(connectionSlug);
    if (!connection) throw new DomainError("MARKETPLACE_NOT_CONFIGURED", "The marketplace connection is not configured.", 404);
    if (!connection.enabled || connection.status !== "active") throw new DomainError("MARKETPLACE_NOT_ACTIVE", "The marketplace connection is not enabled and verified.", 409);
    try { return { connection, provider: this.registry.get(connection.providerSlug) }; }
    catch { throw new DomainError("MARKETPLACE_PROVIDER_UNAVAILABLE", "The configured marketplace provider is unavailable.", 503); }
  }
  private async connectionFor(slug: string): Promise<MarketplaceConnection> { const connection = await this.connections.findBySlug(slug); if (!connection) throw new DomainError("MARKETPLACE_NOT_CONFIGURED", "The marketplace connection is not configured.", 404); return connection; }
  private getProvider(slug: string) { try { return this.registry.get(slug); } catch { throw new DomainError("MARKETPLACE_PROVIDER_UNAVAILABLE", "The requested marketplace provider is unavailable.", 404); } }
  private validate(provider: import("./foundations.js").MarketplaceProvider, configuration: Record<string, unknown>, credentialReference?: string): void { assertSafeConfiguration(configuration); if (credentialReference && !isOpaqueReference(credentialReference)) throw new DomainError("INVALID_CREDENTIAL_REFERENCE", "Credential references must be opaque secret-manager references.", 400); provider.validateConfiguration(configuration); }
  private requireCapability<T extends (...args: any[]) => any>(provider: import("./foundations.js").MarketplaceProvider, capability: keyof Pick<import("./foundations.js").MarketplaceProvider, "discoverProducts" | "searchProducts" | "getProduct" | "getOffers" | "generateAffiliateLink">): T { const method = provider[capability]; if (!method) throw new DomainError("MARKETPLACE_CAPABILITY_UNSUPPORTED", `This marketplace provider does not support ${capability}.`, 409); return method.bind(provider) as T; }
  private toView(connection: MarketplaceConnection): MarketplaceConnectionView { const { credentialReference: _secret, ...view } = connection; return { ...view, hasCredentialReference: Boolean(_secret) }; }
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

const secretKey = /(secret|token|password|api[_-]?key|client[_-]?secret|authorization)/i;
function assertSafeConfiguration(value: Record<string, unknown>): void { for (const [key, item] of Object.entries(value)) { if (secretKey.test(key)) throw new DomainError("UNSAFE_PROVIDER_CONFIGURATION", "Provider configuration must not include credentials or secrets.", 400); if (item && typeof item === "object" && !Array.isArray(item)) assertSafeConfiguration(item as Record<string, unknown>); } }
function isOpaqueReference(value: string): boolean { return /^(?:[a-z][a-z0-9+.-]*:\/\/|[A-Z][A-Z0-9_]*:)[A-Za-z0-9._\-/]+$/i.test(value) && !/[\s]/.test(value); }
function safeErrorMessage(error: unknown): string { const message = error instanceof Error ? error.message : "Connection test failed."; return message.replace(/(token|secret|password|api[_-]?key|authorization)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 500); }
