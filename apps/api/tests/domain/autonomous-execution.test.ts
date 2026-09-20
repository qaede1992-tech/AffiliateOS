import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AffiliateOffer, Product } from "@affiliateos/shared";
import { AutonomousExecutionService } from "../../src/domain/autonomous-execution.js";
import { AutonomousOpportunitySelector } from "../../src/domain/autonomous-opportunity.js";
import type { CampaignOrchestrator, CampaignOrchestrationResult } from "../../src/domain/campaign-orchestrator.js";
import type { ScoredOpportunity } from "../../src/domain/opportunity-scoring.js";

const product: Product = {
  id: "product-1", marketplaceId: "marketplace-1", externalProductId: "external-1", name: "Demo Product",
  priceCents: 10000, currency: "USD", reviewCount: 100, soldCount: 500, productUrl: "https://example.com/product", status: "active",
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};

const offer: AffiliateOffer = {
  id: "offer-1", affiliateAccountId: "affiliate-account-1", productId: product.id, externalOfferId: "external-offer-1",
  status: "active", affiliateLinkStatus: "active", affiliateUrl: "https://example.com/affiliate", commissionBasisPoints: 1200,
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z"
};

const opportunity = {
  product,
  offerId: offer.id,
  score: 80,
  breakdown: { commission: 80, demand: 80, audienceFit: 80, socialProof: 80, priceAppeal: 80, availability: 80, confidence: 80 },
  reasons: ["Strong commission", "Strong demand"]
} as ScoredOpportunity;

const orchestrationResult = {} as CampaignOrchestrationResult;

describe("AutonomousExecutionService", () => {
  it("selects opportunities and executes each selected offer with a deterministic key", async () => {
    const calls: Array<{ offerId: string; idempotencyKey?: string }> = [];
    const orchestrator = {
      execute: async (input: { offer: AffiliateOffer; idempotencyKey?: string }) => {
        calls.push({ offerId: input.offer.id, idempotencyKey: input.idempotencyKey });
        return orchestrationResult;
      }
    } as unknown as CampaignOrchestrator;
    const service = new AutonomousExecutionService(new AutonomousOpportunitySelector(), orchestrator);

    const result = await service.runOnce({
      candidates: [{ product, offers: [offer] }],
      policy: { minimumScore: 60, maximumResults: 1 },
      idempotencyNamespace: "cycle-1"
    });

    assert.equal(result.selected.length, 1);
    assert.deepEqual(result.outcomes.map(({ status, idempotencyKey }) => ({ status, idempotencyKey })), [
      { status: "completed", idempotencyKey: "cycle-1:product-1:offer-1" }
    ]);
    assert.deepEqual(calls, [{ offerId: "offer-1", idempotencyKey: "cycle-1:product-1:offer-1" }]);
  });

  it("continues executing later selected opportunities when one orchestration fails", async () => {
    const product2 = { ...product, id: "product-2", externalProductId: "external-2", name: "Second Product" };
    const offer2 = { ...offer, id: "offer-2", productId: product2.id, externalOfferId: "external-offer-2" };
    const calls: string[] = [];
    const orchestrator = {
      execute: async (input: { product: Product }) => {
        calls.push(input.product.id);
        if (input.product.id === product.id) throw new Error("temporary orchestration failure");
        return orchestrationResult;
      }
    } as unknown as CampaignOrchestrator;
    const selector = {
      select: () => ({
        selected: [opportunity, { ...opportunity, product: product2, offerId: offer2.id } as ScoredOpportunity],
        rejected: []
      })
    } as unknown as AutonomousOpportunitySelector;
    const service = new AutonomousExecutionService(selector, orchestrator);

    const result = await service.runOnce({ candidates: [{ product, offers: [offer] }, { product: product2, offers: [offer2] }] });

    assert.deepEqual(calls, ["product-1", "product-2"]);
    assert.equal(result.outcomes[0]?.status, "failed");
    assert.equal(result.outcomes[0]?.error, "temporary orchestration failure");
    assert.equal(result.outcomes[1]?.status, "completed");
  });

  it("fails a selected opportunity when its offer cannot be resolved", async () => {
    const selector = {
      select: () => ({ selected: [opportunity], rejected: [] })
    } as unknown as AutonomousOpportunitySelector;
    const orchestrator = { execute: async () => orchestrationResult } as unknown as CampaignOrchestrator;
    const service = new AutonomousExecutionService(selector, orchestrator);

    const result = await service.runOnce({ candidates: [{ product, offers: [] }] });

    assert.equal(result.outcomes[0]?.status, "failed");
    assert.equal(result.outcomes[0]?.error, "Selected opportunity has no matching affiliate offer.");
  });
});
