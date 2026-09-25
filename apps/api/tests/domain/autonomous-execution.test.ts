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
  status: "active", affiliateLinkStatus: "active", affiliateUrl: "https://example.com/affiliate", commissionRateBps: 1200,
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
      policy: { minimumScore: 40, maximumResults: 1 },
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

  it("recovers a persisted run using its original execution context", async () => {
    const runRepository = new (await import("../../src/domain/autonomous-run.js")).InMemoryAutonomousRunRepository();
    const runService = new (await import("../../src/domain/autonomous-run-service.js")).AutonomousRunService(runRepository);
    const accepted = await runService.accept({
      idempotencyKey: "previous-cycle:product-1:offer-1",
      productId: product.id,
      offerId: offer.id,
      executionContext: { audience: ["electronics"], platforms: ["instagram"], scheduledAt: "2026-09-21T12:00:00.000Z" },
      now: new Date("2026-09-20T09:00:00.000Z")
    });
    await runService.transition(accepted.id, "failed", { error: "worker interrupted" }, new Date("2026-09-20T09:01:00.000Z"));

    const calls: Array<{ audience?: string[]; platforms?: string[]; scheduledAt?: string; idempotencyKey?: string }> = [];
    const orchestrator = {
      execute: async (input: { audience?: string[]; platforms?: string[]; scheduledAt?: string; idempotencyKey?: string }) => {
        calls.push(input);
        return orchestrationResult;
      }
    } as unknown as CampaignOrchestrator;
    const service = new AutonomousExecutionService(new AutonomousOpportunitySelector(), orchestrator, undefined, runService);

    const result = await service.runOnce({
      candidates: [{ product, offers: [offer] }],
      audience: ["beauty"],
      platforms: ["tiktok"],
      scheduledAt: "2026-09-22T12:00:00.000Z",
      idempotencyNamespace: "new-cycle"
    });

    assert.equal(result.recoveredRunCount, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.audience?.join(","), "electronics");
    assert.equal(calls[0]?.platforms?.join(","), "instagram");
    assert.equal(calls[0]?.scheduledAt, "2026-09-21T12:00:00.000Z");
    assert.equal(calls[0]?.idempotencyKey, "previous-cycle:product-1:offer-1");
  });

  it("does not recover persisted runs while the product is in anomaly halt or recovery", async () => {
    for (const anomaly of ["halt", undefined] as const) {
      const runRepository = new (await import("../../src/domain/autonomous-run.js")).InMemoryAutonomousRunRepository();
      const runService = new (await import("../../src/domain/autonomous-run-service.js")).AutonomousRunService(runRepository);
      const accepted = await runService.accept({
        idempotencyKey: "previous-cycle:product-1:offer-1",
        productId: product.id,
        offerId: offer.id,
        executionContext: { audience: ["electronics"] },
        now: new Date("2026-09-20T09:00:00.000Z")
      });
      await runService.transition(accepted.id, "failed", { error: "worker interrupted" }, new Date("2026-09-20T09:01:00.000Z"));

      const calls: string[] = [];
      const orchestrator = {
        execute: async () => { calls.push("executed"); return orchestrationResult; }
      } as unknown as CampaignOrchestrator;
      const feedback = {
        getSignals: async () => new Map([[product.id, {
          anomaly,
          anomalyRecovery: anomaly === "halt" ? "none" : "recovering"
        }]])
      };
      const service = new AutonomousExecutionService(new AutonomousOpportunitySelector(), orchestrator, feedback, runService);

      const result = await service.runOnce({ candidates: [{ product, offers: [offer] }] });

      assert.equal(result.recoveredRunCount, 0);
      assert.deepEqual(calls, []);
    }
  });

  it("skips recovery when the persisted product is no longer active", async () => {
    const runRepository = new (await import("../../src/domain/autonomous-run.js")).InMemoryAutonomousRunRepository();
    const runService = new (await import("../../src/domain/autonomous-run-service.js")).AutonomousRunService(runRepository);
    const accepted = await runService.accept({
      idempotencyKey: "previous-cycle:product-1:offer-1",
      productId: product.id,
      offerId: offer.id,
      executionContext: { audience: ["electronics"] },
      now: new Date("2026-09-20T09:00:00.000Z")
    });
    await runService.transition(accepted.id, "failed", { error: "worker interrupted" }, new Date("2026-09-20T09:01:00.000Z"));

    const orchestrator = {
      execute: async () => orchestrationResult
    } as unknown as CampaignOrchestrator;
    const service = new AutonomousExecutionService(new AutonomousOpportunitySelector(), orchestrator, undefined, runService);
    const inactiveProduct = { ...product, status: "inactive" as const };

    const result = await service.runOnce({
      candidates: [{ product: inactiveProduct, offers: [offer] }],
      idempotencyNamespace: "new-cycle"
    });

    assert.equal(result.recoveredRunCount, 0);
  });

  it("resolves the selected offer from duplicate product candidates without mixing offers", async () => {
    const alternateOffer = { ...offer, id: "offer-2", externalOfferId: "external-offer-2", commissionRateBps: 1800 };
    const calls: string[] = [];
    const selector = {
      select: () => ({ selected: [{ ...opportunity, offerId: alternateOffer.id }], rejected: [] })
    } as unknown as AutonomousOpportunitySelector;
    const orchestrator = {
      execute: async (input: { offer: AffiliateOffer }) => {
        calls.push(input.offer.id);
        return orchestrationResult;
      }
    } as unknown as CampaignOrchestrator;
    const service = new AutonomousExecutionService(selector, orchestrator);

    const result = await service.runOnce({
      candidates: [
        { product, offers: [offer] },
        { product, offers: [alternateOffer] }
      ]
    });

    assert.equal(result.outcomes[0]?.status, "completed");
    assert.deepEqual(calls, ["offer-2"]);
  });

  it("resolves multiple selected products to their own offers", async () => {
    const product2 = { ...product, id: "product-2", externalProductId: "external-2" };
    const offer2 = { ...offer, id: "offer-2", productId: product2.id, externalOfferId: "external-offer-2" };
    const opportunity2 = { ...opportunity, product: product2, offerId: offer2.id } as ScoredOpportunity;
    const calls: string[] = [];
    const selector = { select: () => ({ selected: [opportunity, opportunity2], rejected: [] }) } as unknown as AutonomousOpportunitySelector;
    const orchestrator = {
      execute: async (input: { product: Product; offer: AffiliateOffer }) => { calls.push(input.product.id + ":" + input.offer.id); return orchestrationResult; }
    } as unknown as CampaignOrchestrator;
    const service = new AutonomousExecutionService(selector, orchestrator);
    const result = await service.runOnce({
      candidates: [{ product, offers: [offer] }, { product: product2, offers: [offer2] }],
      idempotencyNamespace: "cycle-2"
    });
    assert.equal(result.outcomes.every((item) => item.status === "completed"), true);
    assert.deepEqual(calls, ["product-1:offer-1", "product-2:offer-2"]);
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
