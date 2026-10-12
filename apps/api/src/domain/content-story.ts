import type { ContentProduct, ContentStory, EntityId } from "@affiliateos/shared";
import { DomainError } from "./errors.js";
import type { AffiliateOfferRepository, ContentProductRepository, ProductCatalogRepository, Repository } from "./repository.js";
import type { Content } from "@affiliateos/shared";

export interface SetContentProductsInput {
  productId: EntityId;
  affiliateOfferId?: EntityId;
  position: number;
  role: ContentProduct["role"];
}

export class ContentStoryService {
  constructor(
    private readonly contents: Repository<Content>,
    private readonly products: ProductCatalogRepository,
    private readonly affiliateOffers: AffiliateOfferRepository,
    private readonly contentProducts: ContentProductRepository
  ) {}

  async get(contentId: EntityId): Promise<ContentStory> {
    const content = await this.contents.findById(contentId);
    if (!content) throw new DomainError("CONTENT_NOT_FOUND", "The content does not exist.", 404);
    const products = await this.contentProducts.listByContent(contentId);
    products.sort((a, b) => a.position - b.position);
    return { content, products };
  }

  async replaceProducts(contentId: EntityId, input: SetContentProductsInput[]): Promise<ContentStory> {
    await this.requireContent(contentId);
    const seen = new Set<string>();
    const items: ContentProduct[] = [];
    for (const item of input) {
      if (seen.has(item.productId)) throw new DomainError("DUPLICATE_CONTENT_PRODUCT", "A product can only appear once in a story.");
      seen.add(item.productId);
      const product = await this.products.findById(item.productId);
      if (!product) throw new DomainError("PRODUCT_NOT_FOUND", "The product does not exist.", 404);
      if (product.status !== "active") throw new DomainError("PRODUCT_NOT_ACTIVE", "Story recommendations require active products.");
      if (item.affiliateOfferId) {
        const offer = await this.affiliateOffers.findById(item.affiliateOfferId);
        if (!offer) throw new DomainError("AFFILIATE_OFFER_NOT_FOUND", "The affiliate offer does not exist.", 404);
        if (offer.productId !== product.id) throw new DomainError("AFFILIATE_OFFER_PRODUCT_MISMATCH", "The affiliate offer does not belong to the selected product.");
      }
      items.push({ contentId, productId: product.id, affiliateOfferId: item.affiliateOfferId, position: item.position, role: item.role, createdAt: new Date().toISOString() });
    }
    await this.contentProducts.replaceForContent(contentId, items);
    return this.get(contentId);
  }

  private async requireContent(contentId: EntityId) {
    const content = await this.contents.findById(contentId);
    if (!content) throw new DomainError("CONTENT_NOT_FOUND", "The content does not exist.", 404);
    return content;
  }
}
