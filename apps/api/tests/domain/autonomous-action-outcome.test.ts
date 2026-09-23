import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousCampaignActionExecutor } from "../../src/domain/autonomous-campaign-action-executor.js";
import { InMemoryAutonomousActionOutcomeRepository } from "../../src/domain/autonomous-action-outcome.js";

const campaign = { id: "c1", name: "Campaign", objective: "affiliate", status: "paused" as const, audience: {}, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" };

describe("autonomous action outcomes", () => {
  it("records skipped outcomes", async () => {
    const outcomes = new InMemoryAutonomousActionOutcomeRepository();
    const executor = new AutonomousCampaignActionExecutor({ get: async () => campaign }, undefined, undefined, outcomes);
    await executor.execute({ campaignId: "c1", action: "scale", confidence: 0.9, reasons: ["test"] });
    assert.equal(outcomes.outcomes.length, 1);
    assert.equal(outcomes.outcomes[0].status, "skipped");
  });

  it("records failed outcomes", async () => {
    const outcomes = new InMemoryAutonomousActionOutcomeRepository();
    const executor = new AutonomousCampaignActionExecutor({ get: async () => { throw new Error("missing campaign"); } }, undefined, undefined, outcomes);
    await assert.rejects(() => executor.execute({ campaignId: "missing", action: "pause", confidence: 0.8, reasons: ["test"] }));
    assert.equal(outcomes.outcomes[0].status, "failed");
  });
});
