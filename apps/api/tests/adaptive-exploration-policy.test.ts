import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveExplorationPolicyProvider } from "../src/domain/adaptive-exploration-policy.js";

const candidate = (id: string, marketplaceId: string, category: string) => ({
  product: { id, marketplaceId, category } as any,
  offers: []
});

const audit = (productId: string, marketplaceId: string, status: string) => ({
  auditId: `audit-${productId}-${status}`,
  productId,
  marketplaceId,
  selected: true,
  score: 80,
  policy: {},
  reasons: [],
  selectionMode: "exploration",
  cycleId: "cycle",
  createdAt: new Date().toISOString(),
  outcome: {
    status: "completed",
    observedAt: new Date().toISOString(),
    explorationEvaluation: { status, reason: status, confidence: 1 }
  }
} as any);

test("adaptive exploration reduces rate after strong promotion evidence", async () => {
  const reader = { list: async () => Array.from({ length: 5 }, (_, i) => audit(`p${i}`, "m1", "promote-to-exploitation")) };
  const provider = new AdaptiveExplorationPolicyProvider(reader, { minimumSamples: 5, minimumRate: 0.05, maximumRate: 0.5 });
  const rates = await provider.getRates([candidate("p0", "m1", "electronics")], { explorationRate: 0.2 });
  assert.equal(rates.get("p0"), 0.1);
});

test("adaptive exploration increases rate after repeated deprioritization", async () => {
  const reader = { list: async () => Array.from({ length: 5 }, (_, i) => audit(`p${i}`, "m1", "deprioritize")) };
  const provider = new AdaptiveExplorationPolicyProvider(reader, { minimumSamples: 5, maximumRate: 0.5 });
  const rates = await provider.getRates([candidate("p0", "m1", "electronics")], { explorationRate: 0.2 });
  assert.equal(rates.get("p0"), 0.3);
});

test("adaptive exploration remains isolated by marketplace", async () => {
  const reader = { list: async () => Array.from({ length: 5 }, (_, i) => audit(`p${i}`, "m1", "promote-to-exploitation")) };
  const provider = new AdaptiveExplorationPolicyProvider(reader, { minimumSamples: 5 });
  const rates = await provider.getRates([
    candidate("p0", "m1", "electronics"),
    candidate("p1", "m2", "electronics")
  ], { explorationRate: 0.2 });
  assert.equal(rates.get("p0"), 0.1);
  assert.equal(rates.get("p1"), 0.2);
});

test("adaptive exploration preserves base rate when evidence is insufficient", async () => {
  const reader = { list: async () => [audit("p0", "m1", "promote-to-exploitation")] };
  const provider = new AdaptiveExplorationPolicyProvider(reader, { minimumSamples: 5 });
  const rates = await provider.getRates([candidate("p0", "m1", "electronics")], { explorationRate: 0.2 });
  assert.equal(rates.get("p0"), 0.2);
});

test("adaptive exploration prefers persistent category state and applies it without replaying history", async () => {
  let applied = 0;
  const reader = { list: async () => [] };
  const stateRepository = {
    applyEvaluatedAudits: async () => { applied += 1; },
    listByMarketplaces: async () => [{
      id: "s1", marketplaceId: "m1", dimension: "category", dimensionKey: "electronics",
      sampleCount: 5, promotedCount: 5, deprioritizedCount: 0, optimizationPositiveCount: 0, optimizationNegativeCount: 0, observedAt: new Date().toISOString()
    }]
  };
  const provider = new AdaptiveExplorationPolicyProvider(reader, { minimumSamples: 5 }, stateRepository);
  const rates = await provider.getRates([candidate("p0", "m1", "electronics")], { explorationRate: 0.2 });
  assert.equal(applied, 1);
  assert.equal(rates.get("p0"), 0.1);
});

test("adaptive exploration falls back to marketplace state when category and audience evidence are unavailable", async () => {
  const reader = { list: async () => [] };
  const stateRepository = {
    applyEvaluatedAudits: async () => {},
    listByMarketplaces: async () => [{
      id: "s1", marketplaceId: "m1", dimension: "marketplace", dimensionKey: "m1",
      sampleCount: 5, promotedCount: 5, deprioritizedCount: 0, optimizationPositiveCount: 0, optimizationNegativeCount: 0, observedAt: new Date().toISOString()
    }]
  };
  const provider = new AdaptiveExplorationPolicyProvider(reader, { minimumSamples: 5 }, stateRepository);
  const rates = await provider.getRates([candidate("p0", "m1", "electronics")], { explorationRate: 0.2 });
  assert.equal(rates.get("p0"), 0.1);
});

test("adaptive exploration consumes persistent optimization feedback", async () => {
  const reader = { list: async () => [] };
  const stateRepository = {
    applyEvaluatedAudits: async () => {},
    applyOptimizationFeedback: async () => {},
    listByMarketplaces: async () => [{
      id: "s1", marketplaceId: "m1", dimension: "category", dimensionKey: "electronics",
      sampleCount: 0, promotedCount: 0, deprioritizedCount: 0,
      optimizationPositiveCount: 5, optimizationNegativeCount: 0, observedAt: new Date().toISOString()
    }]
  };
  const provider = new AdaptiveExplorationPolicyProvider(reader, { minimumSamples: 5 }, stateRepository);
  const rates = await provider.getRates([candidate("p0", "m1", "electronics")], { explorationRate: 0.2 });
  assert.equal(rates.get("p0"), 0.1);
});
