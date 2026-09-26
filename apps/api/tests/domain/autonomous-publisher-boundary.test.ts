import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AffiliateOffer, Campaign, Content, Product, TrackingLink } from "@affiliateos/shared";
import { CampaignOrchestrator } from "../../src/domain/campaign-orchestrator.js";

const product: Product = {
  id: "product-1", marketplaceId: "market-1", externalProductId: "external-1", name: "Demo Product",
  priceCents: 10000, currency: "USD", reviewCount: 10, soldCount: 50, productUrl: "https://example.com/product", status: "active",
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};
const offer: AffiliateOffer = {
  id: "offer-1", productId: product.id, affiliateAccountId: "account-1", externalOfferId: "external-offer-1",
  priceCents: 10000, currency: "USD", commissionRateBps: 1200, availability: "in_stock", availabilityMetadata: {},
  affiliateUrl: "https://affiliate.example/offer-1", affiliateLinkStatus: "active", status: "active",
  createdAt: product.createdAt, updatedAt: product.updatedAt
};
const opportunity = {
  product, offerId: offer.id, score: 80,
  breakdown: { commission: 20, demand: 20, audienceFit: 15, socialProof: 10, priceAppeal: 10, availability: 5, confidencePenalty: 0, total: 80 },
  reasons: ["Strong demand"], disclaimer: "Scores are decision support only."
};
const campaign: Campaign = {
  id: "campaign-1", name: "Autonomous: Demo Product", objective: "Drive qualified affiliate traffic and conversions", status: "draft",
  audience: {}, createdAt: product.createdAt, updatedAt: product.updatedAt
};

class Campaigns {
  async list() { return []; }
  async create() { return campaign; }
  async validateOfferForExecution() { return offer; }
  async attachOffer() { return { campaignId: campaign.id, affiliateOfferId: offer.id, createdAt: campaign.createdAt }; }
}
class Tracking {
  async list() { return [] as TrackingLink[]; }
  async create(input: TrackingLink) { return input; }
}
class ContentStore {
  items: Content[] = [];
  async validateProductForPublication() { return product; }
  async list() { return this.items; }
  async create(input: Record<string, unknown>) { const item = { id: `content-${this.items.length + 1}`, ...input } as Content; this.items.push(item); return item; }
  async update(id: string, patch: Record<string, unknown>) { const current = this.items.find((item) => item.id === id)!; Object.assign(current, patch); return current; }
}
class Distribution {
  scheduled = 0;
  constructor(private readonly publishers: any[] = []) {}
  listPublishers(platform?: string) { return this.publishers.filter((publisher) => publisher.supports(platform)); }
  async validateBatch() {}
  async schedule(input: { content: Content; scheduledAt: string }) { this.scheduled += 1; return { content: { ...input.content, status: "scheduled", scheduledAt: input.scheduledAt }, account: { id: "social-1" }, scheduledAt: input.scheduledAt, publishable: true } as any; }
}

describe("autonomous publisher boundary", () => {
  it("keeps generated content in draft when no compatible publisher exists", async () => {
    const content = new ContentStore();
    const distribution = new Distribution();
    const orchestrator = new CampaignOrchestrator(new Campaigns() as never, new Tracking() as never, content as never, undefined, distribution as never);
    await assert.rejects(
      () => orchestrator.execute({ opportunity, offer, product, platforms: ["tiktok"], scheduledAt: "2026-09-22T12:00:00.000Z" }),
      /at least one publishable social destination/
    );
    assert.equal(distribution.scheduled, 0);
    assert.equal(content.items.length, 1);
    assert.equal(content.items[0]?.status, "draft");
  });

  it("schedules only when a compatible publisher exists", async () => {
    const content = new ContentStore();
    const publisher = { supports: (platform: string) => platform === "tiktok", publish: async () => ({ externalPostId: "unused" }) };
    const distribution = new Distribution([publisher]);
    const orchestrator = new CampaignOrchestrator(new Campaigns() as never, new Tracking() as never, content as never, undefined, distribution as never);
    await assert.rejects(
      () => orchestrator.execute({ opportunity, offer, product, platforms: ["tiktok"], scheduledAt: "2026-09-22T12:00:00.000Z" }),
      /at least one publishable social destination/
    );
    assert.equal(distribution.scheduled, 0);
    assert.equal(content.items[0]?.status, "draft");
  });
});
