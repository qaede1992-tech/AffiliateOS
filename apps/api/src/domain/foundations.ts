import type { AudienceSegment, GeneratedContent, MarketplaceCapability, MarketplaceOfferInput, MarketplaceProductInput, Product, ProductOpportunity } from "@affiliateos/shared";

export interface MarketplaceProvider {
  readonly slug: string;
  readonly displayName: string;
  readonly connectionMode: "mock" | "official_api";
  readonly capabilities: readonly MarketplaceCapability[];
  validateConfiguration(configuration: Record<string, unknown>): void;
  testConnection?(input: { credentialReference?: string; configuration: Record<string, unknown> }): Promise<{ metadata?: Record<string, unknown> }>;
  discoverProducts?(): Promise<MarketplaceProductInput[]>;
  getProduct?(externalProductId: string): Promise<MarketplaceProductInput | undefined>;
  searchProducts?(query: string): Promise<MarketplaceProductInput[]>;
  getOffers?(externalProductId: string): Promise<MarketplaceOfferInput[]>;
  generateAffiliateLink?(externalOfferId: string): Promise<{ url: string; expiresAt?: string }>;
  syncConversions?(since: string): Promise<{ synced: number }>;
}
export class MarketplaceProviderRegistry {
  private readonly providers = new Map<string, MarketplaceProvider>();
  register(provider: MarketplaceProvider): void { if (this.providers.has(provider.slug)) throw new Error(`Marketplace provider already registered: ${provider.slug}`); this.providers.set(provider.slug, provider); }
  get(slug: string): MarketplaceProvider { const provider = this.providers.get(slug); if (!provider) throw new Error(`Marketplace provider is not configured: ${slug}`); return provider; }
  list(): MarketplaceProvider[] { return [...this.providers.values()]; }
}
/** Deterministic test adapter. It is deliberately labelled mock and cannot represent a live marketplace connection. */
export class MockMarketplaceProvider implements MarketplaceProvider {
  readonly slug = "mock";
  readonly displayName = "Mock marketplace (tests only)";
  readonly connectionMode = "mock" as const;
  readonly capabilities: readonly MarketplaceCapability[] = ["discoverProducts", "searchProducts", "getProduct", "getOffers", "generateAffiliateLink", "syncConversions"];
  constructor(private readonly products: MarketplaceProductInput[] = [], private readonly offers: Record<string, MarketplaceOfferInput[]> = {}) {}
  validateConfiguration(): void {}
  testConnection(): Promise<{ metadata: Record<string, unknown> }> { return Promise.resolve({ metadata: { adapter: "mock", note: "Deterministic test adapter; not a live marketplace connection." } }); }
  discoverProducts(): Promise<MarketplaceProductInput[]> { return Promise.resolve(this.products.map((product) => ({ ...product }))); }
  getProduct(id: string): Promise<MarketplaceProductInput | undefined> { return Promise.resolve(this.products.find((product) => product.externalProductId === id)); }
  searchProducts(query: string): Promise<MarketplaceProductInput[]> { const term = query.trim().toLowerCase(); return Promise.resolve(this.products.filter((product) => `${product.name} ${product.category ?? ""} ${product.description ?? ""}`.toLowerCase().includes(term))); }
  getOffers(id: string): Promise<MarketplaceOfferInput[]> { return Promise.resolve((this.offers[id] ?? []).map((offer) => ({ ...offer }))); }
  generateAffiliateLink(externalOfferId: string): Promise<{ url: string }> { return Promise.resolve({ url: `https://mock-marketplace.invalid/affiliate/${encodeURIComponent(externalOfferId)}` }); }
  syncConversions(): Promise<{ synced: number }> { return Promise.resolve({ synced: 0 }); }
}

export class ProductOpportunityService {
  score(product: Product, commissionRateBps = 0, audienceRelevance = 0): ProductOpportunity {
    const rating = Math.min(20, Math.round((product.ratingMilli ?? 0) / 250));
    const reviews = Math.min(15, Math.round(Math.log10(product.reviewCount + 1) * 4));
    const sales = Math.min(20, Math.round(Math.log10(product.soldCount + 1) * 5));
    const commission = Math.min(30, Math.round(commissionRateBps / 333));
    const audience = Math.min(15, Math.max(0, Math.round(audienceRelevance * 15)));
    const reasons = [`commission signal: ${commission}/30`, `rating signal: ${rating}/20`, `review signal: ${reviews}/15`, `sales signal: ${sales}/20`, `audience signal: ${audience}/15`];
    return { product, score: commission + rating + reviews + sales + audience, reasons, disclaimer: "Opportunity score prioritizes available signals; it is not a prediction or guarantee of sales." };
  }
  rank(products: readonly Product[], commissionByProduct: ReadonlyMap<string, number> = new Map(), relevanceByProduct: ReadonlyMap<string, number> = new Map()): ProductOpportunity[] { return products.map((product) => this.score(product, commissionByProduct.get(product.id), relevanceByProduct.get(product.id))).sort((a, b) => b.score - a.score); }
}
const categorySegments: Record<string, AudienceSegment[]> = { beauty: ["beauty", "lifestyle"], skincare: ["skincare", "beauty", "lifestyle"], baby: ["baby", "parenting"], parenting: ["parenting"], fashion: ["fashion", "lifestyle"], home: ["home", "lifestyle"], kitchen: ["kitchen", "home"], electronics: ["electronics"], deal: ["deal-hunters"] };
export function matchAudiences(product: Pick<Product, "category" | "name" | "description">): AudienceSegment[] { const text = `${product.category ?? ""} ${product.name} ${product.description ?? ""}`.toLowerCase(); return [...new Set(Object.entries(categorySegments).filter(([keyword]) => text.includes(keyword)).flatMap(([, segments]) => segments))]; }

export interface ContentGenerator { generateProductContent(product: Product): Promise<GeneratedContent[]>; generateSocialPost(product: Product, platform: GeneratedContent["platform"]): Promise<GeneratedContent>; generateShortVideoScript(product: Product, platform: "tiktok" | "youtube-shorts"): Promise<GeneratedContent>; generateCampaignContent(products: Product[]): Promise<GeneratedContent[]>; }
export class SafeTemplateContentGenerator implements ContentGenerator {
  async generateSocialPost(product: Product, platform: GeneratedContent["platform"]): Promise<GeneratedContent> { const cta = "Check availability and terms through the affiliate link."; return { platform, title: product.name, caption: `${product.name}${product.category ? ` for ${product.category} shoppers` : ""}. ${cta}`, script: platform === "tiktok" || platform === "youtube-shorts" ? `Show ${product.name}. Highlight only the listed product details. ${cta}` : undefined, cta }; }
  generateProductContent(product: Product): Promise<GeneratedContent[]> { return Promise.all((["tiktok", "instagram", "facebook", "youtube-shorts", "x", "threads"] as const).map((platform) => this.generateSocialPost(product, platform))); }
  generateShortVideoScript(product: Product, platform: "tiktok" | "youtube-shorts"): Promise<GeneratedContent> { return this.generateSocialPost(product, platform); }
  generateCampaignContent(products: Product[]): Promise<GeneratedContent[]> { return Promise.all(products.map((product) => this.generateSocialPost(product, "instagram"))); }
}
export interface SocialMediaProvider { readonly platform: string; connect(): Promise<void>; publish(content: GeneratedContent): Promise<{ externalPostId: string }>; schedule(content: GeneratedContent, scheduledAt: string): Promise<{ externalPostId: string }>; getPostStatus(externalPostId: string): Promise<"scheduled" | "published" | "failed">; getMetrics(externalPostId: string): Promise<{ impressions: number; clicks: number }>; }
export class SocialMediaProviderRegistry { private readonly providers = new Map<string, SocialMediaProvider>(); register(provider: SocialMediaProvider): void { this.providers.set(provider.platform, provider); } get(platform: string): SocialMediaProvider { const provider = this.providers.get(platform); if (!provider) throw new Error(`Social provider is not configured: ${platform}`); return provider; } }
export class MockSocialMediaProvider implements SocialMediaProvider { readonly platform = "mock"; async connect(): Promise<void> {} async publish(): Promise<{ externalPostId: string }> { return { externalPostId: "mock-post" }; } async schedule(): Promise<{ externalPostId: string }> { return { externalPostId: "mock-scheduled-post" }; } async getPostStatus(): Promise<"published"> { return "published"; } async getMetrics(): Promise<{ impressions: number; clicks: number }> { return { impressions: 0, clicks: 0 }; } }
