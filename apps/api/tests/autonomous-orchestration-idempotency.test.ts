import assert from "node:assert/strict";
import test from "node:test";
import { CampaignOrchestrator } from "../src/domain/campaign-orchestrator.js";

test("autonomous orchestration is idempotent across retries", async () => {
  const product = {
    id: "product-1",
    marketplaceId: "marketplace-1",
    name: "Test Product",
    status: "active",
    currency: "USD",
    priceCents: 2500
  } as any;
  const offer = {
    id: "offer-1",
    productId: product.id,
    affiliateUrl: "https://example.com/affiliate",
    affiliateLinkStatus: "active",
    status: "active",
    currency: "USD",
    priceCents: 2500
  } as any;
  const opportunity = {
    product,
    offerId: offer.id,
    score: 82,
    reasons: ["commission signal: 20/30"]
  } as any;

  const campaigns: any[] = [];
  const links: any[] = [];
  const contentItems: any[] = [];
  let campaignCreateCount = 0;
  let trackingCreateCount = 0;
  let contentCreateCount = 0;

  const campaignService: any = {
    validateOfferForExecution: async () => offer,
    list: async () => campaigns,
    create: async (input: any) => {
      campaignCreateCount += 1;
      const campaign = {
        id: "campaign-1",
        ...input,
        audience: input.audience
      };
      campaigns.push(campaign);
      return campaign;
    },
    attachOffer: async (campaignId: string, offerId: string) => ({ campaignId, affiliateOfferId: offerId })
  };
  const trackingService: any = {
    list: async () => links,
    create: async (input: any) => {
      trackingCreateCount += 1;
      const link = { id: "tracking-1", code: input.code, status: "active", ...input };
      links.push(link);
      return link;
    }
  };
  const contentService: any = {
    validateProductForPublication: async () => product,
    list: async () => contentItems,
    create: async (input: any) => {
      contentCreateCount += 1;
      const item = { id: `content-${contentCreateCount}`, ...input };
      contentItems.push(item);
      return item;
    }
  };

  const orchestrator = new CampaignOrchestrator(campaignService, trackingService, contentService);
  const input = {
    opportunity,
    offer,
    product,
    platforms: ["instagram"] as any,
    idempotencyKey: "autonomous:test-product:offer-1"
  };

  const first = await orchestrator.execute(input);
  const second = await orchestrator.execute(input);

  assert.equal(first.campaign.id, second.campaign.id);
  assert.equal(first.trackingLink.id, second.trackingLink.id);
  assert.deepEqual(second.content.map((item: any) => item.id), first.content.map((item: any) => item.id));
  assert.equal(campaignCreateCount, 1);
  assert.equal(trackingCreateCount, 1);
  assert.equal(contentCreateCount, 1);
});
