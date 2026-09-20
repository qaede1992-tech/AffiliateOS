import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AffiliateOffer, Campaign, Content, Product, TrackingLink } from "@affiliateos/shared";
import { CampaignOrchestrator } from "../../src/domain/campaign-orchestrator.js";
import type { ScoredOpportunity } from "../../src/domain/opportunity-scoring.js";

const product: Product = {
  id: "product-1", marketplaceId: "market-1", externalProductId: "external-1", name: "Skincare Serum",
  description: "Daily skincare serum", category: "skincare", priceCents: 5000, currency: "USD", ratingMilli: 4600,
  reviewCount: 1200, soldCount: 8500, productUrl: "https://example.test/product-1", status: "active",
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};
const offer: AffiliateOffer = {
  id: "offer-1", productId: product.id, affiliateAccountId: "account-1", externalOfferId: "external-offer-1",
  priceCents: 5000, currency: "USD", commissionRateBps: 1200, availability: "in_stock", availabilityMetadata: {},
  affiliateUrl: "https://affiliate.example.test/offer-1", affiliateLinkStatus: "active", status: "active",
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};
const opportunity: ScoredOpportunity = {
  product, offerId: offer.id, score: 82, breakdown: { commission: 20, demand: 20, audienceFit: 15, socialProof: 15, priceAppeal: 7, availability: 5, confidencePenalty: 0, total: 82 },
  reasons: ["Strong commission", "Strong demand"], disclaimer: "Scores are decision support only."
};

const campaign: Campaign = { id: "campaign-1", name: "Autonomous: Skincare Serum", objective: "Drive qualified affiliate traffic and conversions", status: "draft", audience: {}, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" };
const attachment = { campaignId: campaign.id, affiliateOfferId: offer.id, createdAt: campaign.createdAt };
const link: TrackingLink = { id: "link-1", affiliateOfferId: offer.id, campaignId: campaign.id, code: "abc123", destinationUrl: offer.affiliateUrl!, status: "active", createdAt: campaign.createdAt, updatedAt: campaign.updatedAt };

class StubCampaigns {
  async create() { return campaign; }
  async attachOffer() { return attachment; }
}
class StubTracking {
  async create() { return link; }
}
class StubContent {
  created: unknown[] = [];
  async create(input: Record<string, unknown>) { this.created.push(input); return { id: `content-${this.created.length}`, ...input } as unknown as Content; }
}

describe("campaign orchestrator", () => {
  it("connects a selected opportunity to campaign, tracking, and platform-specific content", async () => {
    const content = new StubContent();
    const result = await new CampaignOrchestrator(new StubCampaigns() as never, new StubTracking() as never, content as never).execute({
      opportunity, offer, product, audience: ["skincare"], platforms: ["tiktok", "instagram", "tiktok"]
    });
    assert.equal(result.campaign.id, campaign.id);
    assert.equal(result.offerAttachment.affiliateOfferId, offer.id);
    assert.equal(result.trackingLink.destinationUrl, offer.affiliateUrl);
    assert.equal(result.content.length, 2);
    assert.deepEqual(result.content.map((item) => item.platform), ["tiktok", "instagram"]);
    assert.equal(content.created.length, 2);
  });

  it("fails closed when the selected offer cannot be used for promotion", async () => {
    await assert.rejects(
      () => new CampaignOrchestrator(new StubCampaigns() as never, new StubTracking() as never, new StubContent() as never).execute({
        opportunity, offer: { ...offer, affiliateLinkStatus: "unavailable", affiliateUrl: undefined }, product
      }),
      /active affiliate offer and affiliate link/
    );
  });
});
