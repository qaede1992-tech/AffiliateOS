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


test("autonomous orchestration falls back to a marketplace product image for TikTok when no video exists", async () => {
  const product = {
    id: "product-photo-1", marketplaceId: "shopee", name: "Example Photo Product",
    description: "Product description", currency: "IDR", priceCents: 125000,
    imageUrl: "https://cdn.example.test/product-photo.jpg", productUrl: "https://example.test/product-photo",
    reviewCount: 15, soldCount: 30, status: "active"
  } as any;
  const offer = {
    id: "offer-photo-1", productId: product.id, affiliateUrl: "https://example.test/affiliate-photo",
    affiliateLinkStatus: "active", status: "active", currency: "IDR", priceCents: 125000
  } as any;
  const opportunity = { product, offerId: offer.id, score: 81, reasons: ["demand"] } as any;
  const campaigns: any[] = [];
  const links: any[] = [];
  const contents: any[] = [];
  const mediaAssets = new InMemoryMediaAssetRepository();
  const campaignService: any = {
    validateOfferForExecution: async () => offer,
    list: async () => campaigns,
    create: async (input: any) => { const campaign = { id: "campaign-photo-1", ...input }; campaigns.push(campaign); return campaign; },
    attachOffer: async (campaignId: string, offerId: string) => ({ campaignId, affiliateOfferId: offerId })
  };
  const trackingService: any = {
    list: async () => links,
    create: async (input: any) => { const link = { id: "tracking-photo-1", ...input, status: "active" }; links.push(link); return link; }
  };
  const contentService: any = {
    validateProductForPublication: async () => product,
    list: async () => contents,
    create: async (input: any) => { const item = { id: "content-photo-1", ...input }; contents.push(item); return item; },
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
  assert.equal(assets[0].kind, "image");
  assert.equal(assets[0].reference, product.imageUrl);
});


test("copies stored product video duration into content media metadata for TikTok readiness", async () => {
  const product = {
    id: "product-stored-video-1", marketplaceId: "shopee", name: "Stored Video Product",
    description: "Product description", currency: "IDR", priceCents: 150000,
    productUrl: "https://example.test/product", status: "active"
  } as any;
  const offer = {
    id: "offer-stored-video-1", productId: product.id, affiliateUrl: "https://example.test/affiliate",
    affiliateLinkStatus: "active", status: "active", currency: "IDR", priceCents: 150000
  } as any;
  const opportunity = { product, offerId: offer.id, score: 82, reasons: ["demand"] } as any;
  const campaigns: any[] = [];
  const links: any[] = [];
  const contents: any[] = [];
  const mediaAssets = new InMemoryMediaAssetRepository();
  const storedProductVideo = {
    id: "product-media-video-1", productId: product.id, kind: "video", bucket: "affiliate-media",
    objectKey: `products/${product.id}/video.mp4`, mimeType: "video/mp4", byteSize: 1024,
    width: 720, height: 1280, durationMs: 12501, hasAudio: false, sha256: "a".repeat(64),
    sourceUrl: "https://cdn.example.test/video.mp4", sourcePublisher: "Example",
    rightsStatus: "verified", rightsBasis: "user_owned", rightsEvidenceUrl: "https://example.test/rights",
    rightsVerifiedAt: "2026-11-03T00:00:00.000Z", createdAt: "2026-11-03T00:00:00.000Z"
  } as any;
  const campaignService: any = {
    validateOfferForExecution: async () => offer,
    list: async () => campaigns,
    create: async (input: any) => { const campaign = { id: "campaign-stored-video-1", ...input }; campaigns.push(campaign); return campaign; },
    attachOffer: async (campaignId: string, offerId: string) => ({ campaignId, affiliateOfferId: offerId })
  };
  const trackingService: any = {
    list: async () => links,
    create: async (input: any) => { const link = { id: "tracking-stored-video-1", ...input, status: "active" }; links.push(link); return link; }
  };
  const contentService: any = {
    validateProductForPublication: async () => product,
    list: async () => contents,
    create: async (input: any) => { const item = { id: "content-stored-video-1", ...input }; contents.push(item); return item; },
    update: async (id: string, input: any) => {
      const current = contents.find((item) => item.id === id);
      const updated = { ...current, ...input };
      contents.splice(contents.indexOf(current), 1, updated);
      return updated;
    }
  };
  const productMediaAssets: any = { listByProduct: async () => [storedProductVideo] };
  const orchestrator = new CampaignOrchestrator(
    campaignService, trackingService, contentService, undefined, undefined, undefined,
    mediaAssets, undefined, productMediaAssets
  );

  const result = await orchestrator.execute({ opportunity, offer, product, platforms: ["tiktok"] });
  const attached = await mediaAssets.listByContent(result.content[0].id);
  assert.equal(attached.length, 1);
  assert.equal(attached[0].kind, "video");
  assert.equal(attached[0].durationSeconds, 13);
  assert.equal(attached[0].widthPx, 720);
  assert.equal(attached[0].heightPx, 1280);
  assert.equal(attached[0].hasAudio, false);
});
