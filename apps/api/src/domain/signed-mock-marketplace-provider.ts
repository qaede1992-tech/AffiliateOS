import type { MarketplaceCapability, MarketplaceOfferInput, MarketplaceProductInput } from "@affiliateos/shared";
import type { MarketplaceProvider, ProviderEventSignatureHeaders } from "./foundations.js";
import { MockMarketplaceProvider } from "./foundations.js";
import { verifyProviderEventSignature } from "../http/provider-signature.js";

/** Deterministic signed adapter used by integration tests; production adapters must map their real provider headers. */
export class SignedMockMarketplaceProvider implements MarketplaceProvider {
  readonly slug = "mock-signed";
  readonly displayName = "Signed mock marketplace (tests only)";
  readonly connectionMode = "mock" as const;
  readonly capabilities: readonly MarketplaceCapability[] = ["discoverProducts", "searchProducts", "getProduct", "getOffers", "generateAffiliateLink", "syncConversions"];
  private readonly delegate: MockMarketplaceProvider;

  constructor(private readonly signingSecret: string, products: MarketplaceProductInput[] = [], offers: Record<string, MarketplaceOfferInput[]> = {}) {
    this.delegate = new MockMarketplaceProvider(products, offers);
  }

  validateConfiguration(configuration: Record<string, unknown>): void { this.delegate.validateConfiguration(configuration); }
  testConnection() { return this.delegate.testConnection!({ configuration: {} }); }
  discoverProducts() { return this.delegate.discoverProducts!(); }
  getProduct(externalProductId: string) { return this.delegate.getProduct!(externalProductId); }
  searchProducts(query: string) { return this.delegate.searchProducts!(query); }
  getOffers(externalProductId: string) { return this.delegate.getOffers!(externalProductId); }
  generateAffiliateLink(externalOfferId: string) { return this.delegate.generateAffiliateLink!(externalOfferId); }
  syncConversions(since: string) { return this.delegate.syncConversions!(since); }

  verifyEventSignature(input: { rawBody: string; headers: ProviderEventSignatureHeaders; credentialReference?: string; configuration: Record<string, unknown> }): Promise<{ valid: boolean; version?: string }> {
    const valid = verifyProviderEventSignature(input.rawBody, this.signingSecret, input.headers);
    return Promise.resolve(valid ? { valid: true, version: "v1" } : { valid: false });
  }
}
