import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AffiliateOffer, Campaign, Content, Product, TrackingLink } from "@affiliateos/shared";
import { CampaignOrchestrator } from "../../src/domain/campaign-orchestrator.js";
import { AutonomousRunService } from "../../src/domain/autonomous-run-service.js";
import { InMemoryAutonomousRunRepository } from "../../src/domain/autonomous-run.js";
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
  created = 0;
  async list() { return this.created ? [{ ...campaign, audience: { autonomousOrchestrationKey: "run-1" } }] : []; }
  async create() { this.created += 1; return campaign; }
  async validateOfferForExecution() { return offer; }
  async attachOffer() { return attachment; }
}
class StubTracking {
  created = 0;
  codes: string[] = [];
  async list() { return this.created ? [link] : []; }
  async create(input: { code?: string }) { this.created += 1; if (input.code) this.codes.push(input.code); return link; }
}
class StubContent {
  created: Content[] = [];
  async list() { return this.created; }
  async validateProductForPublication() { return product; }
  async create(input: Record<string, unknown>) { const item = { id: `content-${this.created.length + 1}`, ...input } as unknown as Content; this.created.push(item); return item; }
}
class StubDistribution {
  scheduled: Content[] = [];
  async validateBatch() {}
  async schedule(input: { content: Content; scheduledAt: string }) { this.scheduled.push(input.content); return { content: { ...input.content, status: "scheduled", scheduledAt: input.scheduledAt, socialAccountId: "social-1" }, account: { id: "social-1" }, scheduledAt: input.scheduledAt, publishable: false } as never; }
}

describe("campaign orchestrator", () => {
  it("revalidates the live product before creating campaign artifacts", async () => {
    const campaigns = new StubCampaigns();
    const content = new StubContent() as StubContent & { validateProductForPublication: () => Promise<never> };
    content.validateProductForPublication = async () => { throw new Error("PRODUCT_NOT_ACTIVE"); };
    await assert.rejects(
      () => new CampaignOrchestrator(campaigns as never, new StubTracking() as never, content as never).execute({ opportunity, offer, product, platforms: ["tiktok"] }),
      /PRODUCT_NOT_ACTIVE/
    );
    assert.equal(campaigns.created, 0);
    assert.equal(content.created.length, 0);
  });

  it("revalidates the live affiliate offer before creating campaign artifacts", async () => {
    const campaigns = new StubCampaigns();
    campaigns.validateOfferForExecution = async () => { throw new Error("AFFILIATE_LINK_EXPIRED"); };
    const content = new StubContent();
    await assert.rejects(
      () => new CampaignOrchestrator(campaigns as never, new StubTracking() as never, content as never).execute({ opportunity, offer, product, platforms: ["tiktok"] }),
      /AFFILIATE_LINK_EXPIRED/
    );
    assert.equal(campaigns.created, 0);
    assert.equal(content.created.length, 0);
  });

  it("connects a selected opportunity to campaign, tracking, and platform-specific content", async () => {
    const content = new StubContent();
    const result = await new CampaignOrchestrator(new StubCampaigns() as never, new StubTracking() as never, content as never).execute({ opportunity, offer, product, audience: ["skincare"], platforms: ["tiktok", "instagram", "tiktok"] });
    assert.equal(result.campaign.id, campaign.id);
    assert.equal(result.offerAttachment.affiliateOfferId, offer.id);
    assert.equal(result.trackingLink.destinationUrl, offer.affiliateUrl);
    assert.equal(result.content.length, 2);
    assert.deepEqual(result.content.map((item) => item.platform), ["tiktok", "instagram"]);
    assert.equal(content.created.length, 2);
    assert.equal(result.distribution.length, 0);
  });

  it("schedules every generated platform when an explicit schedule is requested", async () => {
    const content = new StubContent();
    const distribution = new StubDistribution();
    const scheduledAt = "2026-09-21T12:00:00.000Z";
    const result = await new CampaignOrchestrator(new StubCampaigns() as never, new StubTracking() as never, content as never, undefined, distribution as never).execute({ opportunity, offer, product, platforms: ["tiktok", "instagram"], scheduledAt });
    assert.equal(distribution.scheduled.length, 2);
    assert.equal(result.distribution.length, 2);
    assert.ok(result.content.every((item) => item.status === "scheduled"));
    assert.ok(result.content.every((item) => item.scheduledAt === scheduledAt));
  });

  it("uses a deterministic tracking code for an orchestration key", async () => {
    const tracking = new StubTracking();
    const content = new StubContent();
    await new CampaignOrchestrator(new StubCampaigns() as never, tracking as never, content as never).execute({
      opportunity, offer, product, idempotencyKey: "stable-run", platforms: ["tiktok"]
    });
    assert.equal(tracking.codes.length, 1);
    assert.match(tracking.codes[0]!, /^auto-[a-f0-9]{32}$/);
  });

  it("is idempotent for a supplied orchestration key", async () => {
    const campaigns = new StubCampaigns();
    const tracking = new StubTracking();
    const content = new StubContent();
    const orchestrator = new CampaignOrchestrator(campaigns as never, tracking as never, content as never);
    const input = { opportunity, offer, product, idempotencyKey: "run-1", platforms: ["tiktok", "instagram"] as const };
    const first = await orchestrator.execute(input);
    const second = await orchestrator.execute(input);
    assert.equal(campaigns.created, 1);
    assert.equal(tracking.created, 1);
    assert.equal(content.created.length, 2);
    assert.equal(first.campaign.id, second.campaign.id);
    assert.deepEqual(first.content.map((item) => item.id), second.content.map((item) => item.id));
  });

  it("persists the autonomous run through orchestration completion", async () => {
    const runs = new InMemoryAutonomousRunRepository();
    const autonomousRuns = new AutonomousRunService(runs);
    const campaigns = new StubCampaigns();
    const tracking = new StubTracking();
    const content = new StubContent();
    const orchestrator = new CampaignOrchestrator(campaigns as never, tracking as never, content as never, undefined, undefined, autonomousRuns);
    await orchestrator.execute({ opportunity, offer, product, idempotencyKey: "run-1", platforms: ["tiktok"] });
    const run = await runs.findByIdempotencyKey("run-1");
    assert.ok(run);
    assert.equal(run.status, "completed");
    assert.equal(run.campaignId, campaign.id);
    assert.equal(run.opportunityProductId, product.id);
    assert.equal(run.offerId, offer.id);
  });
  it("does not mark an unavailable autonomous run failed", async () => {
    const runs = new InMemoryAutonomousRunRepository();
    const autonomousRuns = new AutonomousRunService(runs);
    const accepted = await autonomousRuns.accept({
      idempotencyKey: "busy-run",
      productId: product.id,
      offerId: offer.id,
      now: new Date("2026-09-21T01:00:00.000Z")
    });
    await autonomousRuns.claimProcessing(accepted.id, new Date("2026-09-21T01:00:00.000Z"));

    const orchestrator = new CampaignOrchestrator(
      new StubCampaigns() as never,
      new StubTracking() as never,
      new StubContent() as never,
      undefined,
      undefined,
      autonomousRuns
    );

    await assert.rejects(
      orchestrator.execute({ opportunity, offer, product, idempotencyKey: "busy-run", platforms: ["tiktok"] }),
      /not currently available for execution/
    );
    const run = await runs.findById(accepted.id);
    assert.equal(run?.status, "processing");
    assert.equal(run?.attemptCount, 1);
  });

  it("recovers a stale autonomous run without duplicating campaign, tracking, or content", async () => {
    const runs = new InMemoryAutonomousRunRepository();
    const autonomousRuns = new AutonomousRunService(runs);
    const campaigns = new StubCampaigns();
    campaigns.created = 1;
    const tracking = new StubTracking();
    tracking.created = 1;
    const content = new StubContent();
    await content.create({ productId: product.id, campaignId: campaign.id, platform: "tiktok", contentType: "affiliate-promotion", status: "draft" });
    await content.create({ productId: product.id, campaignId: campaign.id, platform: "instagram", contentType: "affiliate-promotion", status: "draft" });

    const accepted = await autonomousRuns.accept({
      idempotencyKey: "run-1",
      productId: product.id,
      offerId: offer.id,
      now: new Date("2026-09-20T10:00:00.000Z")
    });
    const processing = await autonomousRuns.claimProcessing(accepted.id, new Date("2026-09-20T10:00:00.000Z"));
    await runs.save({
      ...processing.run,
      campaignId: campaign.id,
      updatedAt: "2026-09-20T10:00:00.000Z"
    });

    const orchestrator = new CampaignOrchestrator(
      campaigns as never,
      tracking as never,
      content as never,
      undefined,
      undefined,
      autonomousRuns
    );
    const result = await orchestrator.execute({
      opportunity,
      offer,
      product,
      idempotencyKey: "run-1",
      platforms: ["tiktok", "instagram"]
    });

    assert.equal(result.campaign.id, campaign.id);
    assert.equal(campaigns.created, 1);
    assert.equal(tracking.created, 1);
    assert.equal(content.created.length, 2);
    assert.equal((await runs.findById(accepted.id))?.status, "completed");
  });

});
