import { createHash, randomUUID } from "node:crypto";
import type { AffiliateOffer, AudienceSegment, ContentPlatform, Product } from "@affiliateos/shared";
import type { CampaignService, TrackingService } from "./campaigns.js";
import type { ContentStoryService } from "./content-story.js";
import type { ContentService } from "./content.js";
import { publisherSupportsContent, type DistributionEngine, type DistributionPlan } from "./distribution-engine.js";
import type { ScoredOpportunity } from "./opportunity-scoring.js";
import type { AutonomousRunService } from "./autonomous-run-service.js";
import type { MediaAssetRepository } from "./media-asset.js";

export type CampaignOrchestratorInput = {
  opportunity: ScoredOpportunity;
  offer: AffiliateOffer;
  product: Product;
  campaignName?: string;
  objective?: string;
  audience?: AudienceSegment[];
  platforms?: ContentPlatform[];
  scheduledAt?: string;
  idempotencyKey?: string;
  isTest?: boolean;
  storyProducts?: Array<{ product: Product; offer: AffiliateOffer; role: "primary" | "recommendation" | "alternative" | "comparison"; position: number }>;
};

export type GeneratedCampaignContent = {
  platform: ContentPlatform;
  title: string;
  caption: string;
  script: string;
  cta: string;
};

const defaultPlatforms: ContentPlatform[] = ["instagram", "tiktok"];
const productReferenceNumber = (product: Product): string => product.referenceNumber ? String(product.referenceNumber) : "";
const orchestrationKey = (campaign: Awaited<ReturnType<CampaignService["create"]>>) => campaign.audience.autonomousOrchestrationKey;
const trackingCodeFor = (idempotencyKey: string | undefined, campaignId: string, offerId: string, attempt = 0): string => {
  const seed = `${idempotencyKey ?? campaignId}:${offerId}:${attempt}`;
  return `auto-${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
};

const trackingCodeCandidate = (existing: Awaited<ReturnType<TrackingService["list"]>>, idempotencyKey: string | undefined, campaignId: string, offerId: string): string => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = trackingCodeFor(idempotencyKey, campaignId, offerId, attempt);
    if (!existing.some((link) => link.code === candidate)) return candidate;
  }
  throw new Error("Unable to allocate a deterministic tracking code.");
};

export class DeterministicCampaignContentGenerator implements CampaignContentGenerator {
  generate(input: { product: Product; offer: AffiliateOffer; opportunity: ScoredOpportunity; platform: ContentPlatform }): GeneratedCampaignContent {
    const productName = input.product.name.trim();
    const currency = input.offer.currency ?? input.product.currency;
    const price = new Intl.NumberFormat("id-ID", { style: "currency", currency }).format((input.offer.priceCents ?? input.product.priceCents) / 100);
    const title = productName;
    const referenceNumber = productReferenceNumber(input.product);
    const productLookup = referenceNumber ? `Nomor produk: ${referenceNumber}. Buka toko AffiliateOS melalui tautan di bio dan cari nomor ini.` : "Buka toko AffiliateOS melalui tautan di bio dan cari nama produk ini.";
    const caption = `${productName}. Harga pada katalog saat ini ${price}. ${productLookup} Periksa kembali harga, spesifikasi, dan ketersediaan pada halaman produk sebelum membeli.`;
    const script = `Pembuka: Sedang mencari ${productName}?\nDetail: ${input.product.description?.trim() || "Lihat detail produk dan penawaran yang tersedia."}\nHarga: Harga pada katalog saat ini ${price}; cek kembali harga terbaru pada halaman produk.\nAjakan: Buka tautan untuk melihat detail penawaran.`;
    return { platform: input.platform, title, caption, script, cta: "Lihat detail produk" };
  }
}

export interface CampaignContentGenerator {
  generate(input: {
    product: Product;
    offer: AffiliateOffer;
    opportunity: ScoredOpportunity;
    platform: ContentPlatform;
  }): GeneratedCampaignContent;
}

export type CampaignOrchestrationResult = {
  campaign: Awaited<ReturnType<CampaignService["create"]>>;
  offerAttachment: Awaited<ReturnType<CampaignService["attachOffer"]>>;
  trackingLink: Awaited<ReturnType<TrackingService["create"]>>;
  trackingLinks: Awaited<ReturnType<TrackingService["create"]>>[];
  content: Awaited<ReturnType<ContentService["create"]>>[];
  distribution: DistributionPlan[];
};

export class CampaignOrchestrator {
  constructor(
    private readonly campaigns: CampaignService,
    private readonly tracking: TrackingService,
    private readonly content: ContentService,
    private readonly contentGenerator: CampaignContentGenerator = new DeterministicCampaignContentGenerator(),
    private readonly distribution?: DistributionEngine,
    private readonly autonomousRuns?: AutonomousRunService,
    private readonly mediaAssets?: MediaAssetRepository,
    private readonly contentStory?: ContentStoryService
  ) {}

  async execute(input: CampaignOrchestratorInput): Promise<CampaignOrchestrationResult> {
    if (input.opportunity.product.id !== input.product.id) throw new Error("Campaign opportunity and product must reference the same product.");
    if (input.opportunity.offerId !== input.offer.id) throw new Error("Campaign opportunity and affiliate offer must reference the same offer.");
    if (input.offer.productId !== input.product.id) throw new Error("Affiliate offer must belong to the selected product.");
    if (input.offer.affiliateLinkStatus !== "active" || input.offer.status !== "active") throw new Error("Campaign orchestration requires an active affiliate offer and affiliate link.");
    if (!input.offer.affiliateUrl) throw new Error("Campaign orchestration requires an affiliate URL.");
    if (input.offer.affiliateLinkExpiresAt) { const expiresAt = Date.parse(input.offer.affiliateLinkExpiresAt); if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("Campaign orchestration requires a non-expired affiliate link."); }
    const liveOffer = await this.campaigns.validateOfferForExecution(input.offer.id);
    if (liveOffer.productId !== input.product.id) throw new Error("Live affiliate offer must belong to the selected product.");
    const executionOffer = liveOffer;
    const liveProduct = await this.content.validateProductForPublication(input.product.id);
    if (liveProduct.id !== input.offer.productId) throw new Error("Live product and affiliate offer are inconsistent.");
    if (input.scheduledAt && !this.distribution) throw new Error("Campaign orchestration requires a distribution engine when scheduledAt is provided.");

    const run = input.idempotencyKey && this.autonomousRuns
      ? await this.autonomousRuns.accept({ idempotencyKey: input.idempotencyKey, productId: input.product.id, offerId: input.offer.id, isTest: input.isTest, executionContext: { audience: input.audience ?? [], platforms: [...new Set(input.platforms ?? defaultPlatforms)], scheduledAt: input.scheduledAt } })
      : undefined;

    if (run && run.opportunityProductId !== input.product.id) throw new Error("Autonomous run idempotency key is already bound to a different product.");
    if (run && run.offerId !== input.offer.id) throw new Error("Autonomous run idempotency key is already bound to a different affiliate offer.");

    let currentCampaignId = run?.campaignId;
    let ownsRunAttempt = false;
    let completedRunRecovery = false;
    try {
      if (run) {
        const claim = await this.autonomousRuns!.claimProcessing(run.id);
        if (claim.acquired) ownsRunAttempt = true;
        else if (claim.run.status === "completed") completedRunRecovery = true;
        else throw new Error("Autonomous run is not currently available for execution.");
      }

      const audience = input.audience ?? [];
      const requestedPlatforms = [...new Set(input.platforms ?? defaultPlatforms)];
      let campaign: Awaited<ReturnType<CampaignService["create"]>> | undefined;
      if (input.idempotencyKey) {
        const campaigns = await this.campaigns.list();
        campaign = campaigns.find((candidate) => orchestrationKey(candidate) === input.idempotencyKey);
      }
      if (!campaign) {
        campaign = await this.campaigns.create({
          isTest: input.isTest,
          name: input.campaignName ?? `Autonomous: ${input.product.name}`,
          objective: input.objective ?? "Drive qualified affiliate traffic and conversions",
          status: "draft",
          audience: { audience: audience, productId: input.product.id, marketplaceId: input.product.marketplaceId, opportunityScore: input.opportunity.score, autonomousOrchestrationKey: input.idempotencyKey }
        });
      }
      currentCampaignId = campaign.id;
      if (run && ownsRunAttempt) await this.autonomousRuns!.transition(run.id, "processing", { campaignId: campaign.id });

      const offerAttachment = await this.campaigns.attachOffer(campaign.id, executionOffer.id);
      const affiliateUrl = executionOffer.affiliateUrl;
      if (!affiliateUrl) throw new Error("Executable affiliate offer is missing an affiliate URL.");
      const existingLinks = await this.tracking.list(campaign.id);
      const trackingLink = existingLinks.find((link) =>
        link.affiliateOfferId === executionOffer.id &&
        link.destinationUrl === affiliateUrl &&
        link.status === "active"
      ) ??
        await this.tracking.create({ affiliateOfferId: executionOffer.id, campaignId: campaign.id, destinationUrl: affiliateUrl, code: trackingCodeCandidate(existingLinks, input.idempotencyKey, campaign.id, executionOffer.id) });

      const existingContent = await this.content.list(campaign.id);
      let content: Awaited<ReturnType<ContentService["create"]>>[] = [];
      for (const platform of requestedPlatforms) {
        const existing = existingContent.find((item) => item.platform === platform && item.contentType === "affiliate-promotion" && item.status !== "archived");
        let reusable = existing;
        if (reusable?.status === "failed") {
          reusable = await this.content.update(reusable.id, { status: "draft", scheduledAt: undefined, publishedAt: undefined });
        }
        if (reusable) {
          let reusableCaption = typeof reusable.caption === "string" ? reusable.caption : "";
          reusableCaption = reusableCaption
            .replace(/Kode produk:\s*AOS-[A-Z0-9-]+\.?/gi, "")
            .replace(/Buka toko AffiliateOS melalui tautan di bio dan cari kode ini\./gi, "Buka toko AffiliateOS melalui tautan di bio dan cari nomor produk.");
          const referenceNumber = productReferenceNumber(liveProduct);
          if (reusable.status === "draft" && referenceNumber && !reusableCaption.includes(`Nomor produk: ${referenceNumber}`)) {
            reusableCaption = `${reusableCaption.trim()}\n\nNomor produk: ${referenceNumber}. Buka toko AffiliateOS melalui tautan di bio dan cari nomor ini.`;
          }
          if (platform === "instagram" && reusable.status === "draft" && !/link\s+di\s+bio|tautan\s+di\s+bio/i.test(reusableCaption)) {
            reusableCaption = `${reusableCaption.trim()}\n\nLihat tautan di bio untuk memilih produk.`;
          }
          if (reusable.status === "draft" && reusableCaption !== (typeof reusable.caption === "string" ? reusable.caption : "")) {
            reusable = await this.content.update(reusable.id, { caption: reusableCaption });
          }
          content.push(await this.attachProductMediaIfAvailable(reusable, liveProduct));
        } else {
          const generated = this.contentGenerator.generate({ product: input.product, offer: executionOffer, opportunity: input.opportunity, platform });
          let generatedCaption = typeof generated.caption === "string" ? generated.caption : "";
          const referenceNumber = productReferenceNumber(liveProduct);
          if (referenceNumber && !generatedCaption.includes(`Nomor produk: ${referenceNumber}`)) {
            generatedCaption = `${generatedCaption.trim()}\n\nNomor produk: ${referenceNumber}. Buka toko AffiliateOS melalui tautan di bio dan cari nomor ini.`;
          }
          const caption = platform === "instagram" && !/link\s+di\s+bio|tautan\s+di\s+bio/i.test(generatedCaption)
            ? `${generatedCaption.trim()}\n\nLihat tautan di bio untuk memilih produk.`
            : generatedCaption;
          let created = await this.content.create({ productId: input.product.id, campaignId: campaign.id, platform, contentType: "affiliate-promotion", title: generated.title, caption, script: generated.script, cta: generated.cta, status: "draft" });
          created = await this.attachProductMediaIfAvailable(created, liveProduct);
          content.push(created);
        }
      }

      const distribution: DistributionPlan[] = [];
      if (input.scheduledAt) {
        const requests = content
          .filter((item) => item.status === "draft")
          .filter((item) => this.hasAutopublishableMedia(item))
          .filter((item) => this.distribution!.listPublishers(item.platform).some((publisher) => publisherSupportsContent(publisher, item)))
          .map((item) => ({ content: item, scheduledAt: input.scheduledAt! }));
        if (!requests.length) {
          throw new Error("Campaign orchestration requires at least one publishable social destination when scheduledAt is provided.");
        }
        if (requests.length) {
          await this.distribution!.validateBatch(requests);
          const scheduled = [] as Awaited<ReturnType<DistributionEngine["schedule"]>>[];
          for (const request of requests) scheduled.push(await this.distribution!.schedule(request));
          distribution.push(...scheduled);
          const scheduledById = new Map(scheduled.map((plan) => [plan.content.id, plan.content]));
          content = content.map((item) => scheduledById.get(item.id) ?? item);
        }
      }

      const trackingLinks = [trackingLink];
      if (input.storyProducts?.length) {
        if (!this.contentStory) throw new Error("Multi-product story orchestration requires a content story service.");
        const storyItems = [{ product: liveProduct, offer: executionOffer, role: "primary" as const, position: 0 }, ...input.storyProducts.filter((item) => item.product.id !== liveProduct.id).sort((a, b) => a.position - b.position)];
        const seen = new Set<string>();
        for (const item of storyItems) {
          if (seen.has(item.product.id)) throw new Error("Multi-product story cannot contain duplicate products.");
          seen.add(item.product.id);
          if (item.product.id !== liveProduct.id) {
            const liveStoryProduct = await this.content.validateProductForPublication(item.product.id);
            if (liveStoryProduct.id !== item.product.id) throw new Error("Live story product is inconsistent.");
            const liveStoryOffer = await this.campaigns.validateOfferForExecution(item.offer.id);
            if (liveStoryOffer.productId !== item.product.id) throw new Error("Story affiliate offer must belong to its product.");
            await this.campaigns.attachOffer(campaign.id, liveStoryOffer.id);
            const existingStoryLinks = await this.tracking.list(campaign.id);
            const storyLink = existingStoryLinks.find((link) => link.affiliateOfferId === liveStoryOffer.id && link.destinationUrl === liveStoryOffer.affiliateUrl && link.status === "active")
              ?? await this.tracking.create({ affiliateOfferId: liveStoryOffer.id, campaignId: campaign.id, destinationUrl: liveStoryOffer.affiliateUrl!, code: trackingCodeCandidate(existingStoryLinks, input.idempotencyKey, campaign.id, liveStoryOffer.id) });
            trackingLinks.push(storyLink);
            item.product = liveStoryProduct;
            item.offer = liveStoryOffer;
          }
        }
        if (!completedRunRecovery) {
          for (const item of content) {
            await this.contentStory.replaceProducts(item.id, storyItems.map((story, index) => ({ productId: story.product.id, affiliateOfferId: story.offer.id, position: index, role: index === 0 ? "primary" : story.role })));
          }
        }
      }
      if (run && ownsRunAttempt) await this.autonomousRuns!.transition(run.id, "completed", { campaignId: campaign.id });
      return { campaign, offerAttachment, trackingLink, trackingLinks, content, distribution };
    } catch (error) {
      if (run && ownsRunAttempt) await this.autonomousRuns!.transition(run.id, "failed", { campaignId: currentCampaignId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async attachProductMediaIfAvailable(
    content: Awaited<ReturnType<ContentService["create"]>>,
    product: Product
  ) {
    if (!this.mediaAssets) return content;

    const media = content.platform === "instagram"
      ? { kind: "image" as const, reference: product.imageUrl }
      : content.platform === "tiktok"
        ? product.videoUrl
          ? { kind: "video" as const, reference: product.videoUrl }
          : { kind: "image" as const, reference: product.imageUrl }
        : undefined;

    if (!media?.reference) return content;

    let mediaUrl: URL;
    try {
      mediaUrl = new URL(media.reference);
    } catch {
      return content;
    }
    if (mediaUrl.protocol !== "https:") return content;

    const existing = await this.mediaAssets.listByContent(content.id);
    if (existing.some((asset) => asset.kind === media.kind && asset.source === "url" && asset.reference === media.reference)) {
      return content;
    }

    const now = new Date().toISOString();
    const asset = await this.mediaAssets.save({
      id: randomUUID(),
      contentId: content.id,
      kind: media.kind,
      source: "url",
      reference: media.reference,
      createdAt: now,
      updatedAt: now
    });

    return this.content.update(content.id, {
      mediaAssetIds: [...(content.mediaAssetIds ?? []), asset.id]
    });
  }

  private hasAutopublishableMedia(content: Awaited<ReturnType<ContentService["create"]>>): boolean {
    if (!content.mediaAssetIds?.length) return false;
    return content.platform === "instagram" || content.platform === "tiktok";
  }
}
