import type { AffiliateOffer, Product } from "@affiliateos/shared";
import type { MarketplaceService } from "./marketplace.js";
import type { AutonomousCandidateProvider } from "./autonomous-cycle.js";
import type { AutonomousExecutionCandidate } from "./autonomous-execution.js";

export type AutonomousMarketplaceCandidateProviderOptions = {
  maxProductsPerConnection?: number;
  /** Maximum number of product offer lookups processed concurrently per connection. */
  maxConcurrentProductsPerConnection?: number;
  /** Maximum number of affiliate-link refreshes processed concurrently per product. */
  maxConcurrentOffersPerProduct?: number;
  /** Maximum number of affiliate-link refreshes processed concurrently per connection. */
  maxConcurrentAffiliateLinkRefreshesPerConnection?: number;
};

export class AutonomousMarketplaceCandidateProvider implements AutonomousCandidateProvider {
  private readonly maxProductsPerConnection: number;
  private readonly maxConcurrentProductsPerConnection: number;
  private readonly maxConcurrentOffersPerProduct: number;
  private readonly maxConcurrentAffiliateLinkRefreshesPerConnection: number;

  constructor(
    private readonly marketplace: MarketplaceService,
    options: AutonomousMarketplaceCandidateProviderOptions = {}
  ) {
    this.maxProductsPerConnection = Math.max(1, options.maxProductsPerConnection ?? 100);
    this.maxConcurrentProductsPerConnection = Math.max(1, options.maxConcurrentProductsPerConnection ?? 4);
    this.maxConcurrentOffersPerProduct = Math.max(1, options.maxConcurrentOffersPerProduct ?? 4);
    this.maxConcurrentAffiliateLinkRefreshesPerConnection = Math.max(1, options.maxConcurrentAffiliateLinkRefreshesPerConnection ?? 8);
  }

  async listCandidates(): Promise<AutonomousExecutionCandidate[]> {
    const connections = await this.marketplace.listConnections();
    const activeConnections = connections.filter((connection) => connection.enabled && connection.status === "active");
    const candidates: AutonomousExecutionCandidate[] = [];

    for (const connection of activeConnections) {
      try {
        const products = (await this.marketplace.discoverProducts(connection.slug)).slice(0, this.maxProductsPerConnection);
        const affiliateLinkRefreshGate = createConcurrencyGate(this.maxConcurrentAffiliateLinkRefreshesPerConnection);
        const connectionCandidates = await mapWithConcurrency(products, this.maxConcurrentProductsPerConnection, async (product) => {
          if (product.status !== "active") return undefined;
          try {
            const offers = await this.marketplace.getOffers(connection.slug, product.externalProductId);
            const executableOffers = await this.ensureAffiliateLinks(product.id, connection.slug, product.externalProductId, offers, affiliateLinkRefreshGate);
            return { product, offers: executableOffers };
          } catch {
            return { product, offers: [] };
          }
        });
        candidates.push(...connectionCandidates.filter((candidate): candidate is AutonomousExecutionCandidate => candidate !== undefined));
      } catch {
        continue;
      }
    }

    return deduplicateCandidates(candidates);
  }

  private async ensureAffiliateLinks(productId: string, connectionSlug: string, externalProductId: string, offers: AffiliateOffer[], affiliateLinkRefreshGate: ConcurrencyGate): Promise<AffiliateOffer[]> {
    const now = Date.now();
    const usable = offers.filter((offer) => offer.productId === productId && offer.status === "active");
    const refreshed = await mapWithConcurrency(usable, this.maxConcurrentOffersPerProduct, async (offer) => {
      const linkUsable = offer.affiliateLinkStatus === "active" && Boolean(offer.affiliateUrl) && (!offer.affiliateLinkExpiresAt || new Date(offer.affiliateLinkExpiresAt).getTime() > now);
      if (linkUsable) return offer;
      if (!offer.externalOfferId) return undefined;

      const release = await affiliateLinkRefreshGate.acquire();
      try {
        const linked = await this.marketplace.generateAffiliateLink(connectionSlug, externalProductId, offer.externalOfferId);
        const linkedExpiry = linked.affiliateLinkExpiresAt ? new Date(linked.affiliateLinkExpiresAt).getTime() : undefined;
        const linkedUsable = linked.productId === productId && linked.status === "active" && linked.affiliateLinkStatus === "active" && Boolean(linked.affiliateUrl) && (linkedExpiry === undefined || (Number.isFinite(linkedExpiry) && linkedExpiry > Date.now()));
        return linkedUsable ? linked : undefined;
      } catch {
        return undefined;
      } finally {
        release();
      }
    });
    return refreshed.filter((offer): offer is AffiliateOffer => offer !== undefined);
  }
}

function deduplicateCandidates(candidates: AutonomousExecutionCandidate[]): AutonomousExecutionCandidate[] {
  const byProduct = new Map<string, AutonomousExecutionCandidate>();
  for (const candidate of candidates) {
    const existing = byProduct.get(candidate.product.id);
    if (!existing) {
      byProduct.set(candidate.product.id, candidate);
      continue;
    }
    byProduct.set(candidate.product.id, {
      product: mergeProduct(existing.product, candidate.product),
      offers: mergeOffers(existing.offers, candidate.offers)
    });
  }
  return [...byProduct.values()];
}

function mergeProduct(left: Product, right: Product): Product {
  return new Date(right.updatedAt).getTime() >= new Date(left.updatedAt).getTime() ? right : left;
}

function mergeOffers(left: AffiliateOffer[], right: AffiliateOffer[]): AffiliateOffer[] {
  const byId = new Map<string, AffiliateOffer>();
  for (const offer of [...left, ...right]) {
    const existing = byId.get(offer.id);
    if (!existing || new Date(offer.updatedAt).getTime() >= new Date(existing.updatedAt).getTime()) {
      byId.set(offer.id, offer);
    }
  }
  return [...byId.values()];
}


type ConcurrencyGate = {
  acquire(): Promise<() => void>;
};

function createConcurrencyGate(limit: number): ConcurrencyGate {
  let inFlight = 0;
  const waiters: Array<() => void> = [];

  const release = () => {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    inFlight -= 1;
  };

  const acquire = async (): Promise<() => void> => {
    if (inFlight >= limit) {
      await new Promise<void>((resolve) => waiters.push(resolve));
      return release;
    }
    inFlight += 1;
    return release;
  };

  return { acquire };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await mapper(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}
