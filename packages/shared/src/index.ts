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
export type AudienceSegment = "beauty" | "skincare" | "baby" | "parenting" | "fashion" | "home" | "kitchen" | "electronics" | "lifestyle" | "deal-hunters";
export type CampaignStatus = "draft" | "scheduled" | "active" | "paused" | "completed" | "archived";
export interface GeneratedContent { platform: "tiktok" | "instagram" | "facebook" | "youtube-shorts" | "x" | "threads"; title: string; caption: string; script?: string; cta: string; }
