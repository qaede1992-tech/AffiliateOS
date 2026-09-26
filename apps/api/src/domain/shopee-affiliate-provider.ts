import type { MarketplaceOfferInput, MarketplaceProductInput } from "@affiliateos/shared";
import type { MarketplaceProvider } from "./foundations.js";

export interface ShopeeAffiliateClient {
  testConnection(): Promise<Record<string, unknown>>;
  productOfferV2(): Promise<MarketplaceProductInput[]>;
  searchProductOffers(query: string): Promise<MarketplaceProductInput[]>;
  getProduct(externalProductId: string): Promise<MarketplaceProductInput | undefined>;
  shopOfferV2(): Promise<MarketplaceProductInput[]>;
  getOffers(externalProductId: string): Promise<MarketplaceOfferInput[]>;
  generateShortLink(externalOfferId: string): Promise<{ url: string; expiresAt?: string }>;
  conversionReport(since: string): Promise<{ synced: number }>;
}
export class ShopeeAffiliateProvider implements MarketplaceProvider {
  readonly slug="shopee-affiliate"; readonly displayName="Shopee Affiliate"; readonly connectionMode="official_api" as const;
  readonly capabilities=["discoverProducts","searchProducts","getProduct","getOffers","generateAffiliateLink","syncConversions"] as const;
  constructor(private readonly client:ShopeeAffiliateClient,private readonly configuration:{market:string;apiVersion:string}){}
  validateConfiguration(configuration:Record<string,unknown>):void{
    const market=configuration.market,apiVersion=configuration.apiVersion;
    if(typeof market!=="string"||!/^[A-Z]{2}$/.test(market))throw new Error("Shopee configuration requires a two-letter market code.");
    if(typeof apiVersion!=="string"||!/^v\d+$/.test(apiVersion))throw new Error("Shopee configuration requires an explicit Open API version.");
  }
  async testConnection():Promise<{metadata:Record<string,unknown}>{return {metadata:{provider:this.slug,market:this.configuration.market,apiVersion:this.configuration.apiVersion,...await this.client.testConnection()}};}
  discoverProducts():Promise<MarketplaceProductInput[]>{return this.client.productOfferV2();}
  searchProducts(query:string):Promise<MarketplaceProductInput[]>{return this.client.searchProductOffers(query);}
  getProduct(id:string):Promise<MarketplaceProductInput|undefined>{return this.client.getProduct(id);}
  getOffers(id:string):Promise<MarketplaceOfferInput[]>{return this.client.getOffers(id);}
  generateAffiliateLink(id:string):Promise<{url:string;expiresAt?:string}>{return this.client.generateShortLink(id);}
  syncConversions(since:string):Promise<{synced:number}>{return this.client.conversionReport(since);}
}