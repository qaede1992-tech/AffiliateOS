import type { MarketplaceProductInput, MarketplaceOfferInput } from "@affiliateos/shared";
import { MockMarketplaceProvider, type ProviderEventSignatureHeaders } from "./foundations.js";
import { verifyProviderEventSignature } from "../http/provider-signature.js";

/** Deterministic signed adapter used by integration tests; production adapters must map their real provider headers. */
export class SignedMockMarketplaceProvider extends MockMarketplaceProvider {
  readonly slug = "mock-signed";
  readonly displayName = "Signed mock marketplace (tests only)";

  constructor(
    private readonly signingSecret: string,
    products: MarketplaceProductInput[] = [],
    offers: Record<string, MarketplaceOfferInput[]> = {}
  ) {
    super(products, offers);
  }

  verifyEventSignature(input: {
    rawBody: string;
    headers: ProviderEventSignatureHeaders;
    credentialReference?: string;
    configuration: Record<string, unknown>;
  }): Promise<{ valid: boolean; version?: string }> {
    const valid = verifyProviderEventSignature(input.rawBody, this.signingSecret, input.headers);
    return Promise.resolve(valid ? { valid: true, version: "v1" } : { valid: false });
  }
}
