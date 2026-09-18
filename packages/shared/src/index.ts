export type EntityId = string;
export type MoneyCents = number;
export type IsoTimestamp = string;

export type AffiliateStatus = "active" | "paused" | "pending";
export type OfferStatus = "draft" | "active" | "inactive" | "archived";
export type ConversionStatus = "pending" | "approved" | "rejected";
export type CommissionStatus = "pending" | "approved" | "paid";

export interface Affiliate {
  id: EntityId;
  name: string;
  email: string;
  status: AffiliateStatus;
  createdAt: IsoTimestamp;
}

export interface Offer {
  id: EntityId;
  name: string;
  status: OfferStatus;
  commissionRateBps: number;
  createdAt: IsoTimestamp;
}

export interface Conversion {
  id: EntityId;
  affiliateId: EntityId;
  offerId: EntityId;
  amountCents: MoneyCents;
  status: ConversionStatus;
  occurredAt: IsoTimestamp;
}

export interface Commission {
  id: EntityId;
  conversionId: EntityId;
  affiliateId: EntityId;
  amountCents: MoneyCents;
  status: CommissionStatus;
  createdAt: IsoTimestamp;
}

export interface CreateAffiliateRequest {
  name: string;
  email: string;
}

export interface CreateOfferRequest {
  name: string;
  status: "active" | "inactive";
  commissionRateBps: number;
}

export interface CreateConversionRequest {
  affiliateId: EntityId;
  offerId: EntityId;
  amountCents: MoneyCents;
  occurredAt?: IsoTimestamp;
}

export interface ListResponse<T> {
  data: T[];
}

export interface ErrorResponse {
  error: string;
  status: "active" | "inactive";
  message: string;
}

export interface HealthResponse {
  status: "ok";
  service: "affiliateos-api";
  timestamp: IsoTimestamp;
}
export type MarketplaceStatus = "active" | "inactive" | "pending";
export interface Product {
  id: EntityId; marketplaceId: EntityId; externalProductId: string; name: string;
  description?: string; category?: string; priceCents: number; originalPriceCents?: number;
  currency: string; ratingMilli?: number; reviewCount: number; soldCount: number;
  imageUrl?: string; productUrl: string; status: "active" | "inactive" | "archived";
  createdAt: IsoTimestamp; updatedAt: IsoTimestamp;
}
export interface ProductOpportunity { product: Product; score: number; reasons: string[]; disclaimer: string; }
export type MarketplaceConnectionStatus = "active" | "inactive" | "pending" | "error";
export type MarketplaceConnectionHealth = "unverified" | "healthy" | "unhealthy" | "unsupported";
export type MarketplaceCapability = "discoverProducts" | "searchProducts" | "getProduct" | "getOffers" | "generateAffiliateLink" | "syncConversions";
export type ProductAvailability = "in_stock" | "out_of_stock" | "limited" | "unknown";
export type AffiliateLinkStatus = "not_generated" | "active" | "expired" | "unavailable";
export interface MarketplaceConnection {
  id: EntityId; name: string; slug: string; providerSlug: string; status: MarketplaceConnectionStatus;
  connectionMode: "mock" | "official_api"; enabled: boolean;
  /** Internal opaque secret-manager key only. It is deliberately removed from API responses. */
  credentialReference?: string; configuration: Record<string, unknown>;
  healthStatus: MarketplaceConnectionHealth; healthError?: string; healthMetadata: Record<string, unknown>;
  lastCheckedAt?: IsoTimestamp; lastSuccessfulCheckAt?: IsoTimestamp; lastSuccessfulSyncAt?: IsoTimestamp;
  createdAt: IsoTimestamp; updatedAt: IsoTimestamp;
}
export interface MarketplaceConnectionView extends Omit<MarketplaceConnection, "credentialReference"> { hasCredentialReference: boolean; }
export interface MarketplaceProviderInfo { slug: string; displayName: string; connectionMode: "mock" | "official_api"; configured: boolean; capabilities: MarketplaceCapability[]; supportsConnectionTest: boolean; }
export interface CreateMarketplaceConnectionRequest { name: string; slug: string; providerSlug: string; credentialReference?: string; configuration?: Record<string, unknown>; enabled?: boolean; }
export interface UpdateMarketplaceConnectionRequest { name?: string; credentialReference?: string; configuration?: Record<string, unknown>; }
export interface AffiliateAccount { id: EntityId; marketplaceId: EntityId; name: string; externalReference?: string; status: "active" | "inactive"; credentialReference?: string; configuration: Record<string, unknown>; createdAt: IsoTimestamp; updatedAt: IsoTimestamp; }
/** Provider data normalized before it is persisted in AffiliateOS's catalog. */
export interface MarketplaceProductInput {
  externalProductId: string; name: string; description?: string; category?: string; priceCents: number;
  originalPriceCents?: number; currency: string; ratingMilli?: number; reviewCount?: number; soldCount?: number;
  imageUrl?: string; productUrl: string; availability: ProductAvailability; metadata?: Record<string, unknown>;
}
export interface MarketplaceOfferInput {
  externalOfferId: string; priceCents?: number; currency?: string; commissionRateBps?: number;
  commissionAmountCents?: number; availability: ProductAvailability; metadata?: Record<string, unknown>;
}
export interface AffiliateOffer {
  id: EntityId; productId: EntityId; affiliateAccountId: EntityId; externalOfferId?: string;
  priceCents?: number; currency?: string; commissionRateBps?: number; commissionAmountCents?: number;
  availability: ProductAvailability; availabilityMetadata: Record<string, unknown>; affiliateUrl?: string;
  affiliateLinkStatus: AffiliateLinkStatus; status: "active" | "inactive" | "archived"; createdAt: IsoTimestamp; updatedAt: IsoTimestamp;
}
export type AudienceSegment = "beauty" | "skincare" | "baby" | "parenting" | "fashion" | "home" | "kitchen" | "electronics" | "lifestyle" | "deal-hunters";
export type CampaignStatus = "draft" | "scheduled" | "active" | "paused" | "completed" | "archived";
export interface GeneratedContent { platform: "tiktok" | "instagram" | "facebook" | "youtube-shorts" | "x" | "threads"; title: string; caption: string; script?: string; cta: string; }
