import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousCampaignActionExecutor } from "../../src/domain/autonomous-campaign-action-executor.js";

const campaign = { id: "c1", name: "Campaign", objective: "affiliate", status: "active" as const, audience: {}, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" };

describe("AutonomousCampaignActionExecutor revision", () => {
  it("stages one scheduled content item back to draft", async () => {
    let updated: any;
    const content = { id: "content-1", campaignId: "c1", platform: "tiktok" as const, contentType: "affiliate-promotion", status: "scheduled" as const, scheduledAt: "2026-09-23T02:00:00.000Z", socialAccountId: "account-1", createdAt: campaign.createdAt, updatedAt: campaign.updatedAt };
    const executor = new AutonomousCampaignActionExecutor(
      { get: async () => campaign },
      { list: async () => [content], update: async (id: string, input: any) => { updated = { ...content, ...input, id }; return updated; } }
    );
    const result = await executor.execute({ campaignId: "c1", action: "revise-content", confidence: 0.6, reasons: ["evidence"] });
    assert.equal(result.mutated, true);
    assert.equal(updated.status, "draft");
    assert.equal(updated.scheduledAt, undefined);
    assert.equal(updated.socialAccountId, undefined);
  });

  it("does not mutate when there is no scheduled content", async () => {
    const executor = new AutonomousCampaignActionExecutor(
      { get: async () => campaign },
      { list: async () => [], update: async () => { throw new Error("must not update"); } }
    );
    const result = await executor.execute({ campaignId: "c1", action: "revise-content", confidence: 0.6, reasons: ["evidence"] });
    assert.equal(result.mutated, false);
  });
});
