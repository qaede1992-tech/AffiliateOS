import assert from "node:assert/strict";
import test from "node:test";
import { CampaignOrchestrator } from "../src/domain/campaign-orchestrator.js";
import { InMemoryMediaAssetRepository } from "../src/domain/repository.js";

test("autonomous orchestration persists a marketplace product image for Instagram content", async () => {
  const product = {
    id: "product-1", marketplaceId: "shopee", name: "Example Product",
    description: "Product description", currency: "IDR", priceCents: 100000,
    imageUrl: "https://cdn.example.test/product.jpg", productUrl: "https://example.test/product",
    reviewCount: 10, soldCount: 25, status: "active"
  } as any;
  const offer = {
    id: "offer-1", productId: product.id, affiliateUrl: "https://example.test/affiliate",
    affiliateLinkStatus: "active", status: "active", currency: "IDR", priceCents: 100000
  } as any;
  const opportunity = { product, offerId: offer.id, score: 80, reasons: ["demand"] } as any;
  const campaigns: any[] = [];
  const links: any[] = [];
  const contents: any[] = [];
  const mediaAssets = new InMemoryMediaAssetRepository();

  const campaignService: any = {
    validateOfferForExecution: async () => offer,
    list: async () => campaigns,
    create: async (input: any) => { const campaign = { id: "campaign-1", ...input }; campaigns.push(campaign); return campaign; },
    attachOffer: async (campaignId: string, offerId: string) => ({ campaignId, affiliateOfferId: offerId })
  };
  const trackingService: any = {
    list: async () => links,
    create: async (input: any) => { const link = { id: "tracking-1", ...input, status: "active" }; links.push(link); return link; }
  };
  const contentService: any = {
    validateProductForPublication: async () => product,
    list: async () => contents,
    create: async (input: any) => { const item = { id: "content-1", ...input }; contents.push(item); return item; },
    update: async (id: string, input: any) => {
      const current = contents.find((item) => item.id === id);
      const updated = { ...current, ...input };
      contents.splice(contents.indexOf(current), 1, updated);
      return updated;
    }
  };

  const orchestrator = new CampaignOrchestrator(campaignService, trackingService, contentService, undefined, undefined, undefined, mediaAssets);
  const result = await orchestrator.execute({ opportunity, offer, product, platforms: ["instagram"] });

  assert.equal(result.content[0].mediaAssetIds?.length, 1);
  const assets = await mediaAssets.listByContent(result.content[0].id);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].kind, "image");
  assert.equal(assets[0].reference, product.imageUrl);
});


test("autonomous orchestration persists a marketplace product video for TikTok content", async () => {
  const product = {
    id: "product-video-1", marketplaceId: "shopee", name: "Example Video Product",
    description: "Product description", currency: "IDR", priceCents: 150000,
    videoUrl: "https://cdn.example.test/product.mp4", productUrl: "https://example.test/product-video",
    reviewCount: 20, soldCount: 40, status: "active"
  } as any;
  const offer = {
    id: "offer-video-1", productId: product.id, affiliateUrl: "https://example.test/affiliate-video",
    affiliateLinkStatus: "active", status: "active", currency: "IDR", priceCents: 150000
  } as any;
  const opportunity = { product, offerId: offer.id, score: 82, reasons: ["demand"] } as any;
  const campaigns: any[] = [];
  const links: any[] = [];
  const contents: any[] = [];
  const mediaAssets = new InMemoryMediaAssetRepository();
  const campaignService: any = {
    validateOfferForExecution: async () => offer,
    list: async () => campaigns,
    create: async (input: any) => { const campaign = { id: "campaign-video-1", ...input }; campaigns.push(campaign); return campaign; },
    attachOffer: async (campaignId: string, offerId: string) => ({ campaignId, affiliateOfferId: offerId })
  };
  const trackingService: any = {
    list: async () => links,
    create: async (input: any) => { const link = { id: "tracking-video-1", ...input, status: "active" }; links.push(link); return link; }
  };
  const contentService: any = {
    validateProductForPublication: async () => product,
    list: async () => contents,
    create: async (input: any) => { const item = { id: "content-video-1", ...input }; contents.push(item); return item; },
    update: async (id: string, input: any) => {
      const current = contents.find((item) => item.id === id);
      const updated = { ...current, ...input };
      contents.splice(contents.indexOf(current), 1, updated);
      return updated;
    }
  };

  const orchestrator = new CampaignOrchestrator(campaignService, trackingService, contentService, undefined, undefined, undefined, mediaAssets);
  const result = await orchestrator.execute({ opportunity, offer, product, platforms: ["tiktok"] });

  assert.equal(result.content[0].mediaAssetIds?.length, 1);
  const assets = await mediaAssets.listByContent(result.content[0].id);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].kind, "video");
  assert.equal(assets[0].reference, product.videoUrl);
});
