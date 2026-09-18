import type {
  Affiliate,
  Campaign,
  CampaignOffer,
  Click,
  Commission,
  Conversion,
  CreateAffiliateRequest,
  CreateCampaignRequest,
  CreateOfferRequest,
  CreateTrackingLinkRequest,
  ListResponse,
  MarketplaceConnectionView,
  MarketplaceProviderInfo,
  Offer,
  RecordClickRequest,
  TrackingLink,
  TrackingLinkStats,
  UpdateCampaignRequest
} from "@affiliateos/shared";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(error?.message ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(error?.message ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function remove(path: string): Promise<void> {
  const response = await fetch(path, { method: "DELETE" });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(error?.message ?? `Request failed: ${response.status}`);
  }
}

export const api = {
  affiliates: () => get<ListResponse<Affiliate>>("/api/v1/affiliates"),
  createAffiliate: (input: CreateAffiliateRequest) => post<Affiliate>("/api/v1/affiliates", input),
  offers: () => get<ListResponse<Offer>>("/api/v1/offers"),
  createOffer: (input: CreateOfferRequest) => post<Offer>("/api/v1/offers", input),
  conversions: () => get<ListResponse<Conversion>>("/api/v1/conversions"),
  commissions: () => get<ListResponse<Commission>>("/api/v1/commissions"),
  marketplaceProviders: () => get<ListResponse<MarketplaceProviderInfo>>("/api/v1/marketplaces/providers"),
  marketplaceConnections: () => get<ListResponse<MarketplaceConnectionView>>("/api/v1/marketplaces"),
  campaigns: () => get<ListResponse<Campaign>>("/api/v1/campaigns"),
  campaign: (campaignId: string) => get<Campaign>(`/api/v1/campaigns/${campaignId}`),
  createCampaign: (input: CreateCampaignRequest) => post<Campaign>("/api/v1/campaigns", input),
  updateCampaign: (campaignId: string, input: UpdateCampaignRequest) => patch<Campaign>(`/api/v1/campaigns/${campaignId}`, input),
  campaignOffers: (campaignId: string) => get<ListResponse<CampaignOffer>>(`/api/v1/campaigns/${campaignId}/offers`),
  attachCampaignOffer: (campaignId: string, affiliateOfferId: string) => post<CampaignOffer>(`/api/v1/campaigns/${campaignId}/offers/${affiliateOfferId}`, {}),
  detachCampaignOffer: (campaignId: string, affiliateOfferId: string) => remove(`/api/v1/campaigns/${campaignId}/offers/${affiliateOfferId}`),
  trackingLinks: (campaignId?: string) => get<ListResponse<TrackingLink>>(campaignId ? `/api/v1/tracking-links?campaignId=${encodeURIComponent(campaignId)}` : "/api/v1/tracking-links"),
  createTrackingLink: (input: CreateTrackingLinkRequest) => post<TrackingLink>("/api/v1/tracking-links", input),
  recordClick: (trackingLinkId: string, input: RecordClickRequest = {}) => post<Click>(`/api/v1/tracking-links/${trackingLinkId}/clicks`, input),
  trackingLinkStats: (trackingLinkId: string) => get<TrackingLinkStats>(`/api/v1/tracking-links/${trackingLinkId}/stats`)
};
