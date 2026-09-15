export type EntityId = string;

export type AffiliateStatus = "active" | "paused" | "pending";
export type OfferStatus = "draft" | "active" | "archived";
export type ConversionStatus = "pending" | "approved" | "rejected";
export type CommissionStatus = "pending" | "approved" | "paid";

export interface Affiliate {
  id: EntityId;
  name: string;
  email: string;
  status: AffiliateStatus;
  createdAt: string;
}

export interface Offer {
  id: EntityId;
  name: string;
  status: OfferStatus;
  commissionRate: number;
  createdAt: string;
}

export interface Conversion {
  id: EntityId;
  affiliateId: EntityId;
  offerId: EntityId;
  amount: number;
  status: ConversionStatus;
  occurredAt: string;
}

export interface Commission {
  id: EntityId;
  conversionId: EntityId;
  affiliateId: EntityId;
  amount: number;
  status: CommissionStatus;
  createdAt: string;
}

export interface HealthResponse {
  status: "ok";
  service: "affiliateos-api";
  timestamp: string;
}