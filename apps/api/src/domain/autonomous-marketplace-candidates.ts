import type { AffiliateOffer, Product } from "@affiliateos/shared";
import type { MarketplaceService } from "./marketplace.js";
import type { AutonomousCandidateProvider, AutonomousExecutionCandidate } from "./autonomous-cycle.js";

export type AutonomousMarketplaceCandidateProviderOptions = {
  maxProductsPerConnection?: number;
};

export class AutonomousMarketplaceCandidateProvider implements AutonomousCandidateProvider {
  private readonly maxProductsPerConnection: number;

  constructor(
    private readonly marketplace: MarketplaceService,
    options: AutonomousMarketplaceCandidateProviderOptions = {}
  ) {
    this.maxProductsPerConnection = Math.max(1, options.maxProductsPerConnection ?? 100);
  }

  async listCandidates(): Promise<AutonomousExecutionCandidate[]> {
    const connections = await this.marketplace.listConnections();
    const activeConnections = connections.filter((connection) => connection.enabled && connection.status === "active");
    const candidates: AutonomousExecutionCandidate[] = [];

    for (const connection of activeConnections) {
      try {
        const products = (await this.marketplace.discoverProducts(connection.slug)).slice(0, this.maxProductsPerConnection);
        for (const product of products) {
          try {
            const offers = await this.marketplace.getOffers(connection.slug, product.externalProductId);
            candidates.push({ product, offers });
          } catch {
            candidates.push({ product, offers: [] });
          }
        }
      } catch {
        continue;
      }
    }

    return deduplicateCandidates(candidates);
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
  for (const offer of [...left, ...right]) byId.set(offer.id, offer);
  return [...byId.values()];
}
