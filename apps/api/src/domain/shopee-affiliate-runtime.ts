import { ShopeeAffiliateGraphqlClient } from "./shopee-affiliate-graphql-client.js";
import { ShopeeAffiliateProvider } from "./shopee-affiliate-provider.js";
import type { MarketplaceProvider } from "./foundations.js";

export interface ShopeeRuntimeConfiguration {
  credentialReference?: string;
  appId?: string;
  appSecret?: string;
  market: string;
  apiVersion: string;
}

export function createShopeeAffiliateProvider(configuration: ShopeeRuntimeConfiguration, fetchImpl?: typeof fetch): MarketplaceProvider | undefined {
  const reference = configuration.credentialReference?.trim();
  const appId = configuration.appId?.trim();
  const appSecret = configuration.appSecret;
  if (!reference || !appId || !appSecret) return undefined;
  if (!isOpaqueCredentialReference(reference)) throw new Error("SHOPEE_AFFILIATE_CREDENTIAL_REFERENCE must be an opaque secret-manager reference.");
  const client = new ShopeeAffiliateGraphqlClient({
    market: configuration.market,
    credentials: { appId, secret: appSecret },
    fetchImpl
  });
  return new ShopeeAffiliateProvider(client, { market: configuration.market.toUpperCase(), apiVersion: configuration.apiVersion, credentialReference: reference });
}

function isOpaqueCredentialReference(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|[A-Z][A-Z0-9_]*:)[A-Za-z0-9._\-/]+$/i.test(value) && !/[\s]/.test(value);
}
