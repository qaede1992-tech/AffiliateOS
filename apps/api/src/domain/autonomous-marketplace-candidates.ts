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
            const executableOffers = await this.ensureAffiliateLinks(connection.slug, product.externalProductId, offers);
            candidates.push({ product, offers: executableOffers });
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

  private async ensureAffiliateLinks(connectionSlug: string, externalProductId: string, offers: AffiliateOffer[]): Promise<AffiliateOffer[]> {
    if (typeof this.marketplace.generateAffiliateLink !== "function") return offers.filter((offer) => offer.status === "active" && offer.affiliateLinkStatus === "active" && Boolean(offer.affiliateUrl));

    const executable: AffiliateOffer[] = [];
    const now = Date.now();
    for (const offer of offers) {
      if (offer.status !== "active") continue;
      const linkUsable = offer.affiliateLinkStatus === "active" && Boolean(offer.affiliateUrl) && (!offer.affiliateLinkExpiresAt || new Date(offer.affiliateLinkExpiresAt).getTime() > now);
      if (linkUsable) {
        executable.push(offer);
        continue;
      }
      if (!offer.externalOfferId) continue;
      try {
        const linked = await this.marketplace.generateAffiliateLink(connectionSlug, externalProductId, offer.externalOfferId);
        if (linked.status === "active" && linked.affiliateLinkStatus === "active" && linked.affiliateUrl) executable.push(linked);
      } catch {
        // A provider may reject link generation for an individual offer; keep the cycle running and exclude that offer from execution.
      }
    }
    return executable;
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
