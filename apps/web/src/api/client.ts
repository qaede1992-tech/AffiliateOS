import type { Affiliate, AffiliateOffer, AnalyticsOverview, Campaign, CampaignAnalytics, CampaignOffer, Click, Commission, Content, Conversion, CreateAffiliateRequest, CreateCampaignRequest, CreateContentRequest, CreateOfferRequest, CreateSocialAccountRequest, CreateTrackingLinkRequest, ListResponse, MarketplaceConnectionView, MarketplaceProviderInfo, Offer, Product, RecordClickRequest, SocialAccountView, SocialOAuthStartRequest, SocialOAuthStartResponse, TrackingLink, TrackingLinkStats, UpdateCampaignRequest, UpdateContentRequest, UpdateSocialAccountRequest } from "@affiliateos/shared";

const apiOrigin = (import.meta.env.VITE_API_URL as string | undefined)?.trim().replace(/\/$/, "") ?? "";
const url = (path: string) => `${apiOrigin}${path}`;
export const socialOAuthRedirectUri = () => new URL("/api/v1/social-accounts/oauth/callback", apiOrigin || window.location.origin).toString();
let loginPromise: Promise<void> | null = null;

async function loginWithPrompt(): Promise<void> {
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    const token = window.prompt("AffiliateOS authentication token:");
    if (!token) throw new Error("Authentication is required.");
    await request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    }, true);
  })().finally(() => { loginPromise = null; });
  return loginPromise;
}

async function request<T>(path: string, init: RequestInit = {}, skipAuthRetry = false): Promise<T> {
  const response = await fetch(url(path), { ...init, credentials: "include" });
  if (!response.ok) {
    if (response.status === 401 && !skipAuthRetry && path !== "/api/v1/auth/login") {
      await loginWithPrompt();
      return request<T>(path, init, true);
    }
    const error = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    const requestError = new Error(error?.message ?? `Request failed: ${response.status}`);
    (requestError as Error & { status?: number; code?: string }).status = response.status;
    (requestError as Error & { status?: number; code?: string }).code = error?.error;
    throw requestError;
  }
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const remove = (path: string) => request<void>(path, { method: "DELETE" });

export const api = {
  login: (token: string) => request<{ authenticated: true; operatorId: string; role: string }>("/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }, true),
  logout: () => post<{ authenticated: false }>("/api/v1/auth/logout", {}),
  me: () => get<{ authenticated: true; operatorId: string; role: string }>("/api/v1/auth/me"),
  affiliates: () => get<ListResponse<Affiliate>>("/api/v1/affiliates"), createAffiliate: (input: CreateAffiliateRequest) => post<Affiliate>("/api/v1/affiliates", input),
  offers: () => get<ListResponse<Offer>>("/api/v1/offers"), createOffer: (input: CreateOfferRequest) => post<Offer>("/api/v1/offers", input),
  conversions: () => get<ListResponse<Conversion>>("/api/v1/conversions"), commissions: () => get<ListResponse<Commission>>("/api/v1/commissions"),
  marketplaceProviders: () => get<ListResponse<MarketplaceProviderInfo>>("/api/v1/marketplaces/providers"), marketplaceConnections: () => get<ListResponse<MarketplaceConnectionView>>("/api/v1/marketplaces"), marketplaceSetEnabled: (connectionSlug: string, enabled: boolean) => put<MarketplaceConnectionView>(`/api/v1/marketplaces/${encodeURIComponent(connectionSlug)}/enabled`, enabled ? { enabled: true, confirmation: "CONFIRM_MARKETPLACE_CONNECTION" } : { enabled: false }), products: () => get<ListResponse<Product>>("/api/v1/products"), affiliateOffers: () => get<ListResponse<AffiliateOffer>>("/api/v1/affiliate-offers"),
  campaigns: () => get<ListResponse<Campaign>>("/api/v1/campaigns"), campaign: (campaignId: string) => get<Campaign>(`/api/v1/campaigns/${campaignId}`), createCampaign: (input: CreateCampaignRequest) => post<Campaign>("/api/v1/campaigns", input), updateCampaign: (campaignId: string, input: UpdateCampaignRequest) => patch<Campaign>(`/api/v1/campaigns/${campaignId}`, input),
  campaignOffers: (campaignId: string) => get<ListResponse<CampaignOffer>>(`/api/v1/campaigns/${campaignId}/offers`), attachCampaignOffer: (campaignId: string, affiliateOfferId: string) => post<CampaignOffer>(`/api/v1/campaigns/${campaignId}/offers/${affiliateOfferId}`, {}), detachCampaignOffer: (campaignId: string, affiliateOfferId: string) => remove(`/api/v1/campaigns/${campaignId}/offers/${affiliateOfferId}`),
  trackingLinks: (campaignId?: string) => get<ListResponse<TrackingLink>>(campaignId ? `/api/v1/tracking-links?campaignId=${encodeURIComponent(campaignId)}` : "/api/v1/tracking-links"), createTrackingLink: (input: CreateTrackingLinkRequest) => post<TrackingLink>("/api/v1/tracking-links", input), recordClick: (trackingLinkId: string, input: RecordClickRequest = {}) => post<Click>(`/api/v1/tracking-links/${trackingLinkId}/clicks`, input), trackingLinkStats: (trackingLinkId: string) => get<TrackingLinkStats>(`/api/v1/tracking-links/${trackingLinkId}/stats`),
  analyticsOverview: () => get<AnalyticsOverview>("/api/v1/analytics/overview"),
  autonomousStatus: () => get<{ running: boolean; active: boolean; lastStartedAt?: string; lastCompletedAt?: string; lastResult?: unknown; lastError?: string }>("/api/v1/autonomous/status"),
  autonomousRuns: (limit = 50) => get<ListResponse<{ id: string; idempotencyKey: string; productId: string; offerId: string; status: "accepted" | "processing" | "completed" | "failed"; attemptCount: number; campaignId?: string; lastError?: string; nextAttemptAt?: string; updatedAt: string }>>(`/api/v1/autonomous/runs?limit=${encodeURIComponent(String(limit))}`),\n  autonomousDecisionAudits: (limit = 100) => get<ListResponse<{ auditId: string; cycleId: string; productId: string; marketplaceId: string; selected: boolean; selectionMode?: "exploration" | "exploitation"; score: number; policy: Record<string, unknown>; reasons: string[]; category?: string; audienceSegments?: string[]; createdAt: string; outcome?: { offerId?: string; status: "completed" | "failed"; campaignId?: string; error?: string; observedAt: string; analytics?: { clickCount: number; attributedConversionCount: number; attributedRevenueCents: number; attributedCommissionCents: number; conversionRate: number } } }>>(`/api/v1/autonomous/decision-audits?limit=${encodeURIComponent(String(limit))}`),
  runAutonomousCycle: () => post<{ status: string; result?: unknown; error?: string }>("/api/v1/autonomous/cycles/run", {}), campaignAnalytics: (campaignId: string) => get<CampaignAnalytics>(`/api/v1/analytics/campaigns/${campaignId}`),
  content: (campaignId?: string) => get<ListResponse<Content>>(campaignId ? `/api/v1/content?campaignId=${encodeURIComponent(campaignId)}` : "/api/v1/content"), createContent: (input: CreateContentRequest) => post<Content>("/api/v1/content", input), getContent: (contentId: string) => get<Content>(`/api/v1/content/${contentId}`), updateContent: (contentId: string, input: UpdateContentRequest) => patch<Content>(`/api/v1/content/${contentId}`, input),
  socialAccounts: () => get<ListResponse<SocialAccountView>>("/api/v1/social-accounts"), socialAccount: (socialAccountId: string) => get<SocialAccountView>(`/api/v1/social-accounts/${socialAccountId}`), createSocialAccount: (input: CreateSocialAccountRequest) => post<SocialAccountView>("/api/v1/social-accounts", input), updateSocialAccount: (socialAccountId: string, input: UpdateSocialAccountRequest) => patch<SocialAccountView>(`/api/v1/social-accounts/${socialAccountId}`, input), startSocialOAuth: (input: SocialOAuthStartRequest) => post<SocialOAuthStartResponse>("/api/v1/social-accounts/oauth/start", input), publisherReadiness: () => get<ListResponse<{ platform: string; status: string; reason?: string }>>("/api/v1/publishers/readiness"), createMarketplaceConnection: (input: { name: string; slug: string; providerSlug: string; credentialReference?: string; configuration?: Record<string, unknown> }) => post<MarketplaceConnectionView>("/api/v1/marketplaces", input), marketplaceTest: (slug: string) => post<MarketplaceConnectionView>(`/api/v1/marketplaces/${encodeURIComponent(slug)}/test`, {}), bindMarketplaceAffiliate: (slug: string, affiliateId: string) => put<unknown>(`/api/v1/marketplaces/${encodeURIComponent(slug)}/affiliate-account`, { affiliateId }), discoverMarketplaceProducts: (slug: string) => post<ListResponse<Product>>(`/api/v1/marketplaces/${encodeURIComponent(slug)}/products/discover`, {})
};