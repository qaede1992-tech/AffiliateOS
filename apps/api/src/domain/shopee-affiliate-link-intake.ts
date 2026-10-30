import { createHash, randomUUID } from "node:crypto";
import { resolveShopeeAffiliateLink } from "./shopee-affiliate-link-resolver.js";

export type ShopeeAffiliateLinkIntakeStatus = "received" | "resolving" | "resolved" | "awaiting_offer_data" | "ready_for_catalog" | "imported" | "unresolved" | "failed";
export interface ShopeeAffiliateLinkIntake {
  id: string; marketplaceSlug: "shopee-affiliate-feed"; affiliateUrl: string; normalizedUrlHash: string;
  canonicalProductUrl?: string; shopId?: string; itemId?: string; status: ShopeeAffiliateLinkIntakeStatus;
  reason?: string; sourceMetadata: Record<string, unknown>; createdAt: string; updatedAt: string;
}
export interface ShopeeAffiliateLinkIntakeRepository {
  findByUrlHash(hash: string): Promise<ShopeeAffiliateLinkIntake | undefined>;
  findById(id: string): Promise<ShopeeAffiliateLinkIntake | undefined>;
  saveIfAbsent(intake: ShopeeAffiliateLinkIntake): Promise<ShopeeAffiliateLinkIntake>;
  update(intake: ShopeeAffiliateLinkIntake): Promise<ShopeeAffiliateLinkIntake>;
}
export class InMemoryShopeeAffiliateLinkIntakeRepository implements ShopeeAffiliateLinkIntakeRepository {
  private readonly rows = new Map<string, ShopeeAffiliateLinkIntake>();
  async findByUrlHash(hash: string) { return [...this.rows.values()].find(row => row.normalizedUrlHash === hash); }
  async findById(id: string) { return this.rows.get(id); }
  async saveIfAbsent(intake: ShopeeAffiliateLinkIntake) { const existing = await this.findByUrlHash(intake.normalizedUrlHash); if (existing) return existing; this.rows.set(intake.id, intake); return intake; }
  async update(intake: ShopeeAffiliateLinkIntake) { this.rows.set(intake.id, intake); return intake; }
}
function normalizeAffiliateUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}
export class ShopeeAffiliateLinkIntakeService {
  constructor(private readonly repository: ShopeeAffiliateLinkIntakeRepository, private readonly resolver: typeof resolveShopeeAffiliateLink = resolveShopeeAffiliateLink) {}
  async submit(rawUrl: string): Promise<ShopeeAffiliateLinkIntake> {
    const normalized = normalizeAffiliateUrl(rawUrl);
    const hash = createHash("sha256").update(normalized).digest("hex");
    const existing = await this.repository.findByUrlHash(hash);
    if (existing) return existing;
    const now = new Date().toISOString();
    const intake = await this.repository.saveIfAbsent({ id: randomUUID(), marketplaceSlug: "shopee-affiliate-feed", affiliateUrl: normalized, normalizedUrlHash: hash, status: "resolving", sourceMetadata: {}, createdAt: now, updatedAt: now });
    if (intake.status !== "resolving" || intake.canonicalProductUrl) return intake;
    const result = await this.resolver(normalized);
    const updated: ShopeeAffiliateLinkIntake = {
      ...intake, status: result.status === "resolved" ? "awaiting_offer_data" : "unresolved",
      ...(result.productUrl ? { canonicalProductUrl: result.productUrl } : {}),
      ...(result.shopId ? { shopId: result.shopId } : {}), ...(result.itemId ? { itemId: result.itemId } : {}),
      ...(result.reason ? { reason: result.reason.slice(0, 1000) } : {}),
      sourceMetadata: { resolution: result.status }, updatedAt: new Date().toISOString()
    };
    return this.repository.update(updated);
  }
  get(id: string) { return this.repository.findById(id); }
}
