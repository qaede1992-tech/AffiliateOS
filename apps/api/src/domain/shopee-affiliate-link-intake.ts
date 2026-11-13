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
  listStaleResolving(cutoff: string, limit: number): Promise<ShopeeAffiliateLinkIntake[]>;
  nextStaleResolvingAt(): Promise<string | undefined>;
  claimStaleResolving(id: string, expectedUpdatedAt: string, claimedAt: string): Promise<boolean>;
  updateIfResolving(id: string, expectedUpdatedAt: string, intake: ShopeeAffiliateLinkIntake): Promise<ShopeeAffiliateLinkIntake | undefined>;
}
export class InMemoryShopeeAffiliateLinkIntakeRepository implements ShopeeAffiliateLinkIntakeRepository {
  private readonly rows = new Map<string, ShopeeAffiliateLinkIntake>();
  async findByUrlHash(hash: string) { return [...this.rows.values()].find(row => row.normalizedUrlHash === hash); }
  async findByProductIdentity(shopId: string, itemId: string) { return [...this.rows.values()].find((row) => row.shopId === shopId && row.itemId === itemId); }
  async findById(id: string) { return this.rows.get(id); }
  async saveIfAbsent(intake: ShopeeAffiliateLinkIntake) { const existing = await this.findByUrlHash(intake.normalizedUrlHash); if (existing) return existing; this.rows.set(intake.id, intake); return intake; }
  async update(intake: ShopeeAffiliateLinkIntake) { this.rows.set(intake.id, intake); return intake; }
  async listStaleResolving(cutoff: string, limit: number) {
    return [...this.rows.values()]
      .filter((row) => row.status === "resolving" && row.updatedAt < cutoff)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit);
  }
  async nextStaleResolvingAt() {
    const timestamps = [...this.rows.values()]
      .filter((row) => row.status === "resolving")
      .map((row) => Date.parse(row.updatedAt))
      .filter(Number.isFinite);
    return timestamps.length > 0
      ? new Date(Math.min(...timestamps) + STALE_RESOLVING_INTAKE_MS).toISOString()
      : undefined;
  }
  async updateIfResolving(id: string, expectedUpdatedAt: string, intake: ShopeeAffiliateLinkIntake) {
    const current = this.rows.get(id);
    if (!current || current.status !== "resolving" || current.updatedAt !== expectedUpdatedAt) return undefined;
    this.rows.set(id, intake);
    return intake;
  }
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
export type ShopeeIntakeRecoveryResult = { scanned: number; recovered: number; failed: number; skipped: number };
type StaleResolvingRetryResult = { intake: ShopeeAffiliateLinkIntake; completedByThisAttempt: boolean };

export class ShopeeAffiliateLinkIntakeService {
  private recoveryWakeSignal?: () => void;

  constructor(private readonly repository: ShopeeAffiliateLinkIntakeRepository, private readonly resolver: typeof resolveShopeeAffiliateLink = resolveShopeeAffiliateLink) {}

  setRecoveryWakeSignal(signal?: () => void): void {
    this.recoveryWakeSignal = signal;
  }

  private notifyRecoveryScheduleChanged(): void {
    try { this.recoveryWakeSignal?.(); } catch { /* Wake observers must not change intake semantics. */ }
  }

  async nextStaleResolvingAt(): Promise<Date | undefined> {
    const timestamp = await this.repository.nextStaleResolvingAt();
    if (!timestamp) return undefined;
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }

  async recoverStaleResolvingBatch(options: { batchSize: number; concurrency: number; resolverTimeoutMs: number; now?: Date }): Promise<ShopeeIntakeRecoveryResult> {
    const { batchSize, concurrency, resolverTimeoutMs } = options;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error("Shopee intake recovery batch size must be between 1 and 500.");
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error("Shopee intake recovery concurrency must be between 1 and 20.");
    if (!Number.isInteger(resolverTimeoutMs) || resolverTimeoutMs < 1_000 || resolverTimeoutMs > 60_000) throw new Error("Shopee intake resolver timeout must be between 1000 and 60000 milliseconds.");
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - STALE_RESOLVING_INTAKE_MS).toISOString();
    const candidates = await this.repository.listStaleResolving(cutoff, batchSize);
    let cursor = 0;
    let recovered = 0;
    let failed = 0;
    let skipped = 0;
    const runWorker = async () => {
      while (true) {
        const index = cursor++;
        const candidate = candidates[index];
        if (!candidate) return;
        try {
          const { intake: result, completedByThisAttempt } = await this.retryStaleResolving(candidate, candidate.affiliateUrl, resolverTimeoutMs);
          if (!completedByThisAttempt) {
            skipped += 1;
            continue;
          }
          recovered += 1;
          if (result.status === "unresolved" || result.status === "failed") failed += 1;
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => runWorker()));
    return { scanned: candidates.length, recovered, failed, skipped };
  }

  private async retryStaleResolving(existing: ShopeeAffiliateLinkIntake, normalizedUrl: string, resolverTimeoutMs = 15_000): Promise<StaleResolvingRetryResult> {
    const claimedAt = new Date().toISOString();
    const claimed = await this.repository.claimStaleResolving(existing.id, existing.updatedAt, claimedAt);
    if (!claimed) return { intake: (await this.repository.findByUrlHash(existing.normalizedUrlHash)) ?? existing, completedByThisAttempt: false };
    this.notifyRecoveryScheduleChanged();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let result: Awaited<ReturnType<typeof resolveShopeeAffiliateLink>>;
    try {
      result = await Promise.race([
        this.resolver(normalizedUrl),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Shopee affiliate link resolver timed out after ${resolverTimeoutMs}ms.`)), resolverTimeoutMs);
        })
      ]);
    } catch (error) {
      const now = new Date().toISOString();
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      const completed = await this.repository.updateIfResolving(existing.id, claimedAt, {
        ...existing,
        status: "unresolved",
        reason,
        sourceMetadata: { ...existing.sourceMetadata, recoveredFromStaleResolving: true, recoveryFailure: true },
        updatedAt: now
      });
      if (completed) this.notifyRecoveryScheduleChanged();
      return { intake: completed ?? (await this.repository.findByUrlHash(existing.normalizedUrlHash)) ?? existing, completedByThisAttempt: Boolean(completed) };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const now = new Date().toISOString();
    const hasProductIdentity = result.status === "resolved" && Boolean(result.shopId && result.itemId);

    if (hasProductIdentity && result.shopId && result.itemId) {
      const sameProduct = await this.repository.findByProductIdentity(result.shopId, result.itemId);
      if (sameProduct && sameProduct.id !== existing.id) {
        const completed = await this.repository.updateIfResolving(existing.id, claimedAt, {
          ...existing,
          status: "failed",
          shopId: undefined,
          itemId: undefined,
          reason: "Resolved product identity is already tracked by another intake.",
          sourceMetadata: { ...existing.sourceMetadata, resolution: "resolved", duplicateOfIntakeId: sameProduct.id },
          updatedAt: now
        });
        if (completed) this.notifyRecoveryScheduleChanged();
        return { intake: completed ?? (await this.repository.findByUrlHash(existing.normalizedUrlHash)) ?? existing, completedByThisAttempt: Boolean(completed) };
      }
    }

    const completed = await this.repository.updateIfResolving(existing.id, claimedAt, {
      ...existing,
      status: hasProductIdentity ? "awaiting_offer_data" : "unresolved",
      ...(result.productUrl ? { canonicalProductUrl: result.productUrl } : {}),
      shopId: result.shopId,
      itemId: result.itemId,
      reason: result.reason?.slice(0, 1000) ?? (hasProductIdentity ? undefined : "Shopee resolver did not return a verified product identity."),
      sourceMetadata: { ...existing.sourceMetadata, resolution: result.status, recoveredFromStaleResolving: true },
      updatedAt: now
    });
    if (completed) this.notifyRecoveryScheduleChanged();
    return { intake: completed ?? (await this.repository.findByUrlHash(existing.normalizedUrlHash)) ?? existing, completedByThisAttempt: Boolean(completed) };
  }

  async submit(rawUrl: string): Promise<ShopeeAffiliateLinkIntake> {
    const normalized = normalizeAffiliateUrl(rawUrl);
    const hash = createHash("sha256").update(normalized).digest("hex");
    const existing = await this.repository.findByUrlHash(hash);
    if (existing?.status === "resolving") {
      const updatedAt = Date.parse(existing.updatedAt);
      if (!Number.isFinite(updatedAt) || Date.now() - updatedAt < STALE_RESOLVING_INTAKE_MS) return existing;
      return (await this.retryStaleResolving(existing, normalized)).intake;
    }
    if (existing && existing.status !== "unresolved") return existing;
    const now = new Date().toISOString();
    const intake = existing ?? await this.repository.saveIfAbsent({ id: randomUUID(), marketplaceSlug: "shopee-affiliate-feed", affiliateUrl: normalized, normalizedUrlHash: hash, status: "resolving", sourceMetadata: {}, createdAt: now, updatedAt: now });
    if (!existing && intake.status === "resolving") this.notifyRecoveryScheduleChanged();
    if (intake.status !== "resolving" && intake.status !== "unresolved") return intake;
    const result = await this.resolver(normalized);
    if (result.status === "resolved" && result.shopId && result.itemId) {
      const sameProduct = await this.repository.findByProductIdentity(result.shopId, result.itemId);
      if (sameProduct && sameProduct.id !== intake.id) {
        const duplicate: ShopeeAffiliateLinkIntake = {
          ...intake,
          status: "failed",
          shopId: undefined,
          itemId: undefined,
          reason: "Resolved product identity is already tracked by another intake.",
          sourceMetadata: { ...intake.sourceMetadata, resolution: "resolved", duplicateOfIntakeId: sameProduct.id },
          updatedAt: new Date().toISOString()
        };
        if (intake.status === "resolving") {
          const completed = await this.repository.updateIfResolving(intake.id, intake.updatedAt, duplicate);
          if (completed) this.notifyRecoveryScheduleChanged();
        } else {
          await this.repository.update(duplicate);
        }
        return sameProduct;
      }
    }
    const updated: ShopeeAffiliateLinkIntake = {
      ...intake, status: result.status === "resolved" ? "awaiting_offer_data" : "unresolved",
      ...(result.productUrl ? { canonicalProductUrl: result.productUrl } : {}),
      ...(result.shopId ? { shopId: result.shopId } : {}), ...(result.itemId ? { itemId: result.itemId } : {}),
      ...(result.reason ? { reason: result.reason.slice(0, 1000) } : {}),
      sourceMetadata: { resolution: result.status }, updatedAt: new Date().toISOString()
    };
    try {
      if (intake.status === "resolving") {
        const completed = await this.repository.updateIfResolving(intake.id, intake.updatedAt, updated);
        if (completed) this.notifyRecoveryScheduleChanged();
        return completed ?? (await this.repository.findByUrlHash(hash)) ?? intake;
      }
      return await this.repository.update(updated);
    }
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
