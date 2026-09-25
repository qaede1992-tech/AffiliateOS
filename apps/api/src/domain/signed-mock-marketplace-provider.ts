import type { MarketplaceCapability, MarketplaceOfferInput, MarketplaceProductInput } from "@affiliateos/shared";
import type { MarketplaceProvider, ProviderEventSignatureHeaders } from "./foundations.js";
import { verifyProviderEventSignature } from "../http/provider-signature.js";

/** Deterministic signed adapter used by integration tests; production adapters must map their real provider headers. */
export class SignedMockMarketplaceProvider implements MarketplaceProvider {
  readonly slug = "mock-signed";
  readonly displayName = "Signed mock marketplace (tests only)";
  readonly connectionMode = "mock" as const;
  readonly capabilities: readonly MarketplaceCapability[] = ["discoverProducts", "searchProducts", "getProduct", "getOffers", "generateAffiliateLink", "syncConversions"];
  constructor(
    private readonly signingSecret: string,
    private readonly products: MarketplaceProductInput[] = [],
    private readonly offers: Record<string, MarketplaceOfferInput[]> = {}
  ) {}

  validateConfiguration(_configuration: Record<string, unknown>): void {}
  testConnection(): Promise<{ metadata: Record<string, unknown> }> {
    return Promise.resolve({ metadata: { adapter: "mock-signed", note: "Deterministic signed test adapter; not a live marketplace connection." } });
  }
  discoverProducts(): Promise<MarketplaceProductInput[]> {
    return Promise.resolve(this.products.map((product) => ({ ...product })));
  }
  getProduct(externalProductId: string): Promise<MarketplaceProductInput | undefined> {
    return Promise.resolve(this.products.find((product) => product.externalProductId === externalProductId));
  }
  searchProducts(query: string): Promise<MarketplaceProductInput[]> {
    const term = query.trim().toLowerCase();
    return Promise.resolve(this.products.filter((product) => `${product.name} ${product.category ?? ""} ${product.description ?? ""}`.toLowerCase().includes(term)));
  }
  getOffers(externalProductId: string): Promise<MarketplaceOfferInput[]> {
    return Promise.resolve((this.offers[externalProductId] ?? []).map((offer) => ({ ...offer })));
  }
  generateAffiliateLink(externalOfferId: string): Promise<{ url: string }> {
    return Promise.resolve({ url: `https://mock-marketplace.invalid/affiliate/${encodeURIComponent(externalOfferId)}` });
  }
  syncConversions(): Promise<{ synced: number }> {
    return Promise.resolve({ synced: 0 });
  }

  verifyEventSignature(input: { rawBody: string; headers: ProviderEventSignatureHeaders; credentialReference?: string; configuration: Record<string, unknown> }): Promise<{ valid: boolean; version?: string }> {
    const valid = verifyProviderEventSignature(input.rawBody, this.signingSecret, input.headers);
    return Promise.resolve(valid ? { valid: true, version: "v1" } : { valid: false });
  }
}
