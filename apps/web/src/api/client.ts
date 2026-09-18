import type {
  Affiliate,
  Commission,
  Conversion,
  CreateAffiliateRequest,
  CreateOfferRequest,
  ListResponse,
  Offer
} from "@affiliateos/shared";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;

    throw new Error(error?.message ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  affiliates: () => get<ListResponse<Affiliate>>("/api/v1/affiliates"),
  createAffiliate: (input: CreateAffiliateRequest) =>
    post<Affiliate>("/api/v1/affiliates", input),
  offers: () => get<ListResponse<Offer>>("/api/v1/offers"),
  createOffer: (input: CreateOfferRequest) =>
    post<Offer>("/api/v1/offers", input),
  conversions: () => get<ListResponse<Conversion>>("/api/v1/conversions"),
  commissions: () => get<ListResponse<Commission>>("/api/v1/commissions")
};
