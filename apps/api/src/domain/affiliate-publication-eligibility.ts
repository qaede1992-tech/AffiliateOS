import type { Content } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import { isExplicitlyAffiliateEligible } from "./opportunity-scoring.js";
import type { AffiliateOfferRepository, CampaignOfferRepository, ProductCatalogRepository, TrackingLinkRepository } from "./repository.js";

export interface AffiliatePublicationEligibilityValidator {
  validate(content: Content): Promise<void>;
}

export class RepositoryAffiliatePublicationEligibilityValidator implements AffiliatePublicationEligibilityValidator {
  constructor(
    private readonly products: ProductCatalogRepository,
    private readonly affiliateOffers: AffiliateOfferRepository,
    private readonly campaignOffers: CampaignOfferRepository,
    private readonly trackingLinks: TrackingLinkRepository
  ) {}

  async validate(content: Content): Promise<void> {
    if (content.contentType !== "affiliate-promotion") return;
    if (!content.productId) throw new DomainError("PRODUCT_NOT_FOUND", "Affiliate promotion content requires a product.", 404);
    const product = await this.products.findById(content.productId);
    if (!product) throw new DomainError("PRODUCT_NOT_FOUND", "The product does not exist.", 404);
    if (product.status !== "active") throw new DomainError("PRODUCT_NOT_ACTIVE", "Affiliate promotion content requires an active product.");
    if (!content.campaignId) throw new DomainError("AFFILIATE_OFFER_NOT_AVAILABLE", "Affiliate promotion content requires a campaign with an active affiliate offer.");

    const attachments = await this.campaignOffers.listByCampaign(content.campaignId);
    const links = await this.trackingLinks.listByCampaign(content.campaignId);

    for (const attachment of attachments) {
      const offer = await this.affiliateOffers.findById(attachment.affiliateOfferId);
      if (!offer || offer.productId !== product.id || offer.status !== "active" || !isExplicitlyAffiliateEligible(offer)) continue;
      if (offer.affiliateLinkStatus !== "active" || !offer.affiliateUrl) continue;
      if (offer.affiliateLinkExpiresAt) {
        const expiresAt = Date.parse(offer.affiliateLinkExpiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) continue;
      }
      if (links.some((link) => link.status === "active" && link.affiliateOfferId === offer.id && link.destinationUrl === offer.affiliateUrl)) return;
    }

    throw new DomainError("AFFILIATE_OFFER_NOT_AVAILABLE", "Affiliate promotion content requires an active, eligible affiliate offer and tracking link.");
  }
}
