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
  claimStaleResolving(id: string, expectedUpdatedAt: string, staleBefore: string, claimedAt: string): Promise<boolean>;
}
export class InMemoryShopeeAffiliateLinkIntakeRepository implements ShopeeAffiliateLinkIntakeRepository {
  private readonly rows = new Map<string, ShopeeAffiliateLinkIntake>();
  async findByUrlHash(hash: string) { return [...this.rows.values()].find(row => row.normalizedUrlHash === hash); }
  async findByProductIdentity(shopId: string, itemId: string) { return [...this.rows.values()].find((row) => row.shopId === shopId && row.itemId === itemId); }
  async findById(id: string) { return this.rows.get(id); }
  async saveIfAbsent(intake: ShopeeAffiliateLinkIntake) { const existing = await this.findByUrlHash(intake.normalizedUrlHash); if (existing) return existing; this.rows.set(intake.id, intake); return intake; }
  async update(intake: ShopeeAffiliateLinkIntake) { this.rows.set(intake.id, intake); return intake; }
  async claimStaleResolving(id: string, expectedUpdatedAt: string, staleBefore: string, claimedAt: string) {
    const current = this.rows.get(id);
    if (!current || current.status !== "resolving" || current.updatedAt !== expectedUpdatedAt || current.updatedAt >= staleBefore) return false;
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
export class ShopeeAffiliateLinkIntakeService {
  constructor(private readonly repository: ShopeeAffiliateLinkIntakeRepository, private readonly resolver: typeof resolveShopeeAffiliateLink = resolveShopeeAffiliateLink) {}

  /**
   * Preserve the URL-level intake as a terminal deduplication record without
   * copying the unique product identity onto it. The canonical row owns that
   * identity; this avoids both orphaned "resolving" rows and the DB unique index.
   */
  private async completeDuplicate(
    intake: ShopeeAffiliateLinkIntake,
    canonical: ShopeeAffiliateLinkIntake,
    productUrl?: string
  ): Promise<ShopeeAffiliateLinkIntake> {
    if (intake.id !== canonical.id && intake.status === "resolving") {
      await this.repository.update({
        ...intake,
        status: "resolved",
        ...(productUrl ? { canonicalProductUrl: productUrl } : {}),
        reason: "Duplicate product identity; linked to canonical intake.",
        sourceMetadata: {
          ...intake.sourceMetadata,
          resolution: "resolved",
          duplicateOfIntakeId: canonical.id
        },
        updatedAt: new Date().toISOString()
      });
    }
    return canonical;
  }

  private async resolveClaimed(intake: ShopeeAffiliateLinkIntake): Promise<ShopeeAffiliateLinkIntake> {
    // The HTTP resolver has its own network timeout; this outer bound protects
    // the workflow if a custom resolver stalls or ignores that timeout.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let result: Awaited<ReturnType<typeof resolveShopeeAffiliateLink>>;
    try {
      result = await Promise.race([
        this.resolver(intake.affiliateUrl),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Shopee affiliate link resolver timed out.")), 15_000);
        })
      ]);
    } catch (error) {
      result = { status: "unresolved", affiliateUrl: intake.affiliateUrl, reason: error instanceof Error ? error.message.slice(0, 1000) : "Shopee affiliate link resolution failed." };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (result.status === "resolved" && result.shopId && result.itemId) {
      const sameProduct = await this.repository.findByProductIdentity(result.shopId, result.itemId);
      if (sameProduct) return this.completeDuplicate(intake, sameProduct, result.productUrl);
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
        if (sameProduct) return this.completeDuplicate(intake, sameProduct, result.productUrl);
      }
      throw error;
    }
  }

  async submit(rawUrl: string): Promise<ShopeeAffiliateLinkIntake> {
    const normalized = normalizeAffiliateUrl(rawUrl);
    const hash = createHash("sha256").update(normalized).digest("hex");
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - 60_000).toISOString();
    const existing = await this.repository.findByUrlHash(hash);
    let intake: ShopeeAffiliateLinkIntake;
    if (existing) {
      if (existing.status !== "resolving" || existing.canonicalProductUrl) return existing;
      if (existing.updatedAt >= staleBefore) return existing;
      const claimed = await this.repository.claimStaleResolving(existing.id, existing.updatedAt, staleBefore, now);
      if (!claimed) return (await this.repository.findById(existing.id)) ?? existing;
      intake = { ...existing, updatedAt: now };
    } else {
      const proposed: ShopeeAffiliateLinkIntake = { id: randomUUID(), marketplaceSlug: "shopee-affiliate-feed", affiliateUrl: normalized, normalizedUrlHash: hash, status: "resolving", sourceMetadata: {}, createdAt: now, updatedAt: now };
      const saved = await this.repository.saveIfAbsent(proposed);
      if (saved.id !== proposed.id) {
        if (saved.status !== "resolving" || saved.canonicalProductUrl || saved.updatedAt >= staleBefore) return saved;
        const claimed = await this.repository.claimStaleResolving(saved.id, saved.updatedAt, staleBefore, now);
        if (!claimed) return (await this.repository.findById(saved.id)) ?? saved;
      }
      intake = { ...saved, updatedAt: now };
    }
    return this.resolveClaimed(intake);
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
