export type EntityId = string;
export type MoneyCents = number;
export type IsoTimestamp = string;

export type AffiliateStatus = "active" | "paused" | "pending";
export type OfferStatus = "draft" | "active" | "archived";
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
  message: string;
}

export interface HealthResponse {
  status: "ok";
  service: "affiliateos-api";
  timestamp: IsoTimestamp;
}