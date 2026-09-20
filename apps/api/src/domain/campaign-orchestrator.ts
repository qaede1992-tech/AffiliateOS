import type { AffiliateOffer, AudienceSegment, ContentPlatform, Product } from "@affiliateos/shared";
import type { CampaignService, TrackingService } from "./campaigns.js";
import type { ContentService } from "./content.js";
import type { DistributionEngine, DistributionPlan } from "./distribution-engine.js";
import type { ScoredOpportunity } from "./opportunity-scoring.js";

export type CampaignOrchestratorInput = {
  opportunity: ScoredOpportunity;
  offer: AffiliateOffer;
  product: Product;
  campaignName?: string;
  objective?: string;
  audience?: AudienceSegment[];
  platforms?: ContentPlatform[];
  scheduledAt?: string;
};

export type GeneratedCampaignContent = {
  platform: ContentPlatform;
  title: string;
  caption: string;
  script: string;
  cta: string;
};

export interface CampaignContentGenerator {
  generate(input: {
    product: Product;
    offer: AffiliateOffer;
    opportunity: ScoredOpportunity;
    platform: ContentPlatform;
  }): GeneratedCampaignContent;
}

const defaultPlatforms: ContentPlatform[] = ["tiktok", "instagram", "facebook"];

export class DeterministicCampaignContentGenerator implements CampaignContentGenerator {
  generate(input: { product: Product; offer: AffiliateOffer; opportunity: ScoredOpportunity; platform: ContentPlatform }): GeneratedCampaignContent {
    const productName = input.product.name.trim();
    const price = new Intl.NumberFormat("en-US", { style: "currency", currency: input.offer.currency ?? input.product.currency }).format((input.offer.priceCents ?? input.product.priceCents) / 100);
    const title = `${productName}: worth a look?`;
    const caption = `${productName} is currently available for ${price}. ${input.opportunity.reasons.slice(0, 2).join(" ")} Check the offer and compare the details before buying.`;
    const script = `Hook: Looking for ${productName}?\nHighlight: ${input.product.description?.trim() || "See the product details and current offer."}\nValue: Current offer price is ${price}.\nCTA: Check the offer through the link.`;
    return { platform: input.platform, title, caption, script, cta: "Check the offer" };
  }
}

export type CampaignOrchestrationResult = {
  campaign: Awaited<ReturnType<CampaignService["create"]>>;
  offerAttachment: Awaited<ReturnType<CampaignService["attachOffer"]>>;
  trackingLink: Awaited<ReturnType<TrackingService["create"]>>;
  content: Awaited<ReturnType<ContentService["create"]>>[];
  distribution: DistributionPlan[];
};

export class CampaignOrchestrator {
  constructor(
    private readonly campaigns: CampaignService,
    private readonly tracking: TrackingService,
    private readonly content: ContentService,
    private readonly contentGenerator: CampaignContentGenerator = new DeterministicCampaignContentGenerator(),
    private readonly distribution?: DistributionEngine
  ) {}

  async execute(input: CampaignOrchestratorInput): Promise<CampaignOrchestrationResult> {
    if (input.opportunity.product.id !== input.product.id) throw new Error("Campaign opportunity and product must reference the same product.");
    if (input.opportunity.offerId !== input.offer.id) throw new Error("Campaign opportunity and affiliate offer must reference the same offer.");
    if (input.offer.productId !== input.product.id) throw new Error("Affiliate offer must belong to the selected product.");
    if (input.offer.affiliateLinkStatus !== "active" || input.offer.status !== "active") throw new Error("Campaign orchestration requires an active affiliate offer and affiliate link.");
    if (!input.offer.affiliateUrl) throw new Error("Campaign orchestration requires an affiliate URL.");
    if (input.scheduledAt && !this.distribution) throw new Error("Campaign orchestration requires a distribution engine when scheduledAt is provided.");

    const audience = input.audience ?? [];
    const campaign = await this.campaigns.create({
      name: input.campaignName ?? `Autonomous: ${input.product.name}`,
      objective: input.objective ?? "Drive qualified affiliate traffic and conversions",
      status: "draft",
      audience: { segments: audience, productId: input.product.id, opportunityScore: input.opportunity.score }
    });
    const offerAttachment = await this.campaigns.attachOffer(campaign.id, input.offer.id);
    const trackingLink = await this.tracking.create({ affiliateOfferId: input.offer.id, campaignId: campaign.id, destinationUrl: input.offer.affiliateUrl });

    const platforms = [...new Set(input.platforms ?? defaultPlatforms)];
    const content = await Promise.all(platforms.map((platform) => {
      const generated = this.contentGenerator.generate({ product: input.product, offer: input.offer, opportunity: input.opportunity, platform });
      return this.content.create({ productId: input.product.id, campaignId: campaign.id, platform, contentType: "affiliate-promotion", title: generated.title, caption: generated.caption, script: generated.script, cta: generated.cta, status: "draft" });
    }));

    const distribution: DistributionPlan[] = [];
    if (input.scheduledAt) {
      for (const item of content) {
        distribution.push(await this.distribution!.schedule({ content: item, scheduledAt: input.scheduledAt }));
      }
    }

    return { campaign, offerAttachment, trackingLink, content: distribution.length ? distribution.map((item) => item.content) : content, distribution };
  }
}
