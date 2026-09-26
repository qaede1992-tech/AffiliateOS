import type { MarketplaceOfferInput, MarketplaceProductInput } from "@affiliateos/shared";
import type { MarketplaceProvider } from "./foundations.js";

export interface TikTokShopAffiliateClient {
  testConnection(): Promise<Record<string, unknown>>;
  discoverProducts(): Promise<MarketplaceProductInput[]>;
  searchProducts(query: string): Promise<MarketplaceProductInput[]>;
  getProduct(externalProductId: string): Promise<MarketplaceProductInput | undefined>;
  getOffers(externalProductId: string): Promise<MarketplaceOfferInput[]>;
  generateAffiliateLink(externalOfferId: string): Promise<{ url: string; expiresAt?: string }>;
  syncConversions(since: string): Promise<{ synced: number }>;
}

/**
 * Official TikTok Shop Affiliate adapter boundary.
 *
 * The HTTP/OAuth implementation is intentionally injected through
 * TikTokShopAffiliateClient. This keeps access tokens, app secrets and
 * TikTok's signing implementation outside domain records and source control.
 */
export class TikTokShopAffiliateProvider implements MarketplaceProvider {
  readonly slug = "tiktok-shop-affiliate";
  readonly displayName = "TikTok Shop Affiliate";
  readonly connectionMode = "official_api" as const;
  readonly capabilities = [
    "discoverProducts",
    "searchProducts",
    "getProduct",
    "getOffers",
    "generateAffiliateLink",
    "syncConversions"
  ] as const;

  constructor(
    private readonly client: TikTokShopAffiliateClient,
    private readonly configuration: { market: string; apiVersion: string }
  ) {}

  validateConfiguration(configuration: Record<string, unknown>): void {
    const market = configuration.market;
    const apiVersion = configuration.apiVersion;
    if (typeof market !== "string" || !/^[A-Z]{2}$/.test(market)) {
      throw new Error("TikTok Shop configuration requires a two-letter market code.");
    }
    if (typeof apiVersion !== "string" || !/^\d{6}$/.test(apiVersion)) {
      throw new Error("TikTok Shop configuration requires a YYYYMM API version.");
    }
  }

  async testConnection(): Promise<{ metadata: Record<string, unknown> }> {
    return { metadata: { provider: this.slug, market: this.configuration.market, apiVersion: this.configuration.apiVersion, ...(await this.client.testConnection()) } };
  }

  discoverProducts(): Promise<MarketplaceProductInput[]> { return this.client.discoverProducts(); }
  searchProducts(query: string): Promise<MarketplaceProductInput[]> { return this.client.searchProducts(query); }
  getProduct(externalProductId: string): Promise<MarketplaceProductInput | undefined> { return this.client.getProduct(externalProductId); }
  getOffers(externalProductId: string): Promise<MarketplaceOfferInput[]> { return this.client.getOffers(externalProductId); }
  generateAffiliateLink(externalOfferId: string): Promise<{ url: string; expiresAt?: string }> { return this.client.generateAffiliateLink(externalOfferId); }
  syncConversions(since: string): Promise<{ synced: number }> { return this.client.syncConversions(since); }
}
