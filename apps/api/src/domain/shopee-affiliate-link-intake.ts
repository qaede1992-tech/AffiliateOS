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
  findByProductIdentity(shopId: string, itemId: string): Promise<ShopeeAffiliateLinkIntake | undefined>;
  findById(id: string): Promise<ShopeeAffiliateLinkIntake | undefined>;
  saveIfAbsent(intake: ShopeeAffiliateLinkIntake): Promise<ShopeeAffiliateLinkIntake>;
  update(intake: ShopeeAffiliateLinkIntake): Promise<ShopeeAffiliateLinkIntake>;
  claimStaleResolving(id: string, expectedUpdatedAt: string, claimedAt: string): Promise<boolean>;
}
export class InMemoryShopeeAffiliateLinkIntakeRepository implements ShopeeAffiliateLinkIntakeRepository {
  private readonly rows = new Map<string, ShopeeAffiliateLinkIntake>();
  async findByUrlHash(hash: string) { return [...this.rows.values()].find(row => row.normalizedUrlHash === hash); }
  async findByProductIdentity(shopId: string, itemId: string) { return [...this.rows.values()].find((row) => row.shopId === shopId && row.itemId === itemId); }
  async findById(id: string) { return this.rows.get(id); }
  async saveIfAbsent(intake: ShopeeAffiliateLinkIntake) { const existing = await this.findByUrlHash(intake.normalizedUrlHash); if (existing) return existing; this.rows.set(intake.id, intake); return intake; }
  async update(intake: ShopeeAffiliateLinkIntake) { this.rows.set(intake.id, intake); return intake; }
  async claimStaleResolving(id: string, expectedUpdatedAt: string, claimedAt: string) {
    const current = this.rows.get(id);
    if (!current || current.status !== "resolving" || current.updatedAt !== expectedUpdatedAt) return false;
    this.rows.set(id, { ...current, updatedAt: claimedAt });
    return true;
  }
}
function normalizeAffiliateUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}
const STALE_RESOLVING_INTAKE_MS = 5 * 60_000;

export class ShopeeAffiliateLinkIntakeService {
  constructor(private readonly repository: ShopeeAffiliateLinkIntakeRepository, private readonly resolver: typeof resolveShopeeAffiliateLink = resolveShopeeAffiliateLink) {}

  private async retryStaleResolving(existing: ShopeeAffiliateLinkIntake, normalizedUrl: string): Promise<ShopeeAffiliateLinkIntake> {
    const claimedAt = new Date().toISOString();
    const claimed = await this.repository.claimStaleResolving(existing.id, existing.updatedAt, claimedAt);
    if (!claimed) return (await this.repository.findByUrlHash(existing.normalizedUrlHash)) ?? existing;

    const result = await this.resolver(normalizedUrl);
    const now = new Date().toISOString();
    const hasProductIdentity = result.status === "resolved" && Boolean(result.shopId && result.itemId);

    if (hasProductIdentity && result.shopId && result.itemId) {
      const sameProduct = await this.repository.findByProductIdentity(result.shopId, result.itemId);
      if (sameProduct && sameProduct.id !== existing.id) {
        await this.repository.update({
          ...existing,
          status: "failed",
          shopId: undefined,
          itemId: undefined,
          reason: "Resolved product identity is already tracked by another intake.",
          sourceMetadata: { ...existing.sourceMetadata, resolution: "resolved", duplicateOfIntakeId: sameProduct.id },
          updatedAt: now
        });
        return sameProduct;
      }
    }

    return this.repository.update({
      ...existing,
      status: hasProductIdentity ? "awaiting_offer_data" : "unresolved",
      ...(result.productUrl ? { canonicalProductUrl: result.productUrl } : {}),
      shopId: result.shopId,
      itemId: result.itemId,
      reason: result.reason?.slice(0, 1000) ?? (hasProductIdentity ? undefined : "Shopee resolver did not return a verified product identity."),
      sourceMetadata: { ...existing.sourceMetadata, resolution: result.status, recoveredFromStaleResolving: true },
      updatedAt: now
    });
  }

  async submit(rawUrl: string): Promise<ShopeeAffiliateLinkIntake> {
    const normalized = normalizeAffiliateUrl(rawUrl);
    const hash = createHash("sha256").update(normalized).digest("hex");
    const existing = await this.repository.findByUrlHash(hash);
    if (existing?.status === "resolving") {
      const updatedAt = Date.parse(existing.updatedAt);
      if (!Number.isFinite(updatedAt) || Date.now() - updatedAt < STALE_RESOLVING_INTAKE_MS) return existing;
      return this.retryStaleResolving(existing, normalized);
    }
    if (existing && existing.status !== "unresolved") return existing;
    const now = new Date().toISOString();
    const intake = existing ?? await this.repository.saveIfAbsent({ id: randomUUID(), marketplaceSlug: "shopee-affiliate-feed", affiliateUrl: normalized, normalizedUrlHash: hash, status: "resolving", sourceMetadata: {}, createdAt: now, updatedAt: now });
    if (intake.status !== "resolving" && intake.status !== "unresolved") return intake;
    const result = await this.resolver(normalized);
    if (result.status === "resolved" && result.shopId && result.itemId) {
      const sameProduct = await this.repository.findByProductIdentity(result.shopId, result.itemId);
      if (sameProduct) return sameProduct;
    }
    const updated: ShopeeAffiliateLinkIntake = {
      ...intake, status: result.status === "resolved" ? "awaiting_offer_data" : "unresolved",
      ...(result.productUrl ? { canonicalProductUrl: result.productUrl } : {}),
      ...(result.shopId ? { shopId: result.shopId } : {}), ...(result.itemId ? { itemId: result.itemId } : {}),
      ...(result.reason ? { reason: result.reason.slice(0, 1000) } : {}),
      sourceMetadata: { resolution: result.status }, updatedAt: new Date().toISOString()
    };
    try { return await this.repository.update(updated); }
    catch (error) {
      if (result.status === "resolved" && result.shopId && result.itemId) {
        const sameProduct = await this.repository.findByProductIdentity(result.shopId, result.itemId);
        if (sameProduct) return sameProduct;
      }
      throw error;
    }
  }

  async reconcileVerifiedOffer(productUrl: string) {
    let url: URL;
    try { url = new URL(productUrl); } catch { return undefined; }
    if (url.protocol !== "https:" || !(url.hostname === "shopee.co.id" || url.hostname.endsWith(".shopee.co.id") || url.hostname === "shopee.com" || url.hostname.endsWith(".shopee.com"))) return undefined;
    const match = /\/product\/(\d+)\/(\d+)(?:[/?#]|$)/i.exec(url.pathname) ?? /-i\.(\d+)\.(\d+)(?:[/?#]|$)/i.exec(url.pathname);
    if (!match?.[1] || !match[2]) return undefined;
    const existing = await this.repository.findByProductIdentity(match[1], match[2]);
    if (!existing) return undefined;
    const updated: ShopeeAffiliateLinkIntake = {
      ...existing, status: "imported", reason: undefined,
      sourceMetadata: { ...existing.sourceMetadata, verifiedOfferSource: "shopee-affiliate-feed", offerDataVerifiedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString()
    };
    return this.repository.update(updated);
  }
  get(id: string) { return this.repository.findById(id); }
}
