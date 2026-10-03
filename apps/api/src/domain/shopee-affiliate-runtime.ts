import type { MarketplaceProvider } from "./foundations.js";

/**
 * Runtime boundary for the current Shopee Affiliate access model.
 *
 * Shopee App ID/App Secret are intentionally not part of the supported
 * production contract. The official API adapter remains isolated until
 * Shopee grants Affiliate Open API access under a credential model that
 * AffiliateOS can use without those legacy application credentials.
 */
export interface ShopeeRuntimeConfiguration {
  credentialReference?: string;
  market: string;
  apiVersion: string;
}

export function createShopeeAffiliateProvider(
  configuration: ShopeeRuntimeConfiguration,
  _fetchImpl?: typeof fetch
): MarketplaceProvider | undefined {
  const reference = configuration.credentialReference?.trim();
  if (!reference) return undefined;
  if (!isOpaqueCredentialReference(reference)) {
    throw new Error("SHOPEE_AFFILIATE_CREDENTIAL_REFERENCE must be an opaque secret-manager reference.");
  }

  // No live provider is activated until Shopee exposes a supported access
  // mechanism that matches this credential-reference-only contract.
  return undefined;
}

function isOpaqueCredentialReference(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|[A-Z][A-Z0-9_]*:)[A-Za-z0-9._\-/]+$/i.test(value) && !/[\s]/.test(value);
}
