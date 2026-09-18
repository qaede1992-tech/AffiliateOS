import type {
  Affiliate,
  Commission,
  Conversion,
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

export const api = {
  affiliates: () => get<ListResponse<Affiliate>>("/api/v1/affiliates"),
  offers: () => get<ListResponse<Offer>>("/api/v1/offers"),
  conversions: () => get<ListResponse<Conversion>>("/api/v1/conversions"),
  commissions: () => get<ListResponse<Commission>>("/api/v1/commissions")
};
