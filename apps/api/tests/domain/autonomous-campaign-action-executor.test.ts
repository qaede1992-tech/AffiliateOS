import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutonomousCampaignActionExecutor } from "../../src/domain/autonomous-campaign-action-executor.js";

const campaign = { id: "c1", name: "Campaign", objective: "affiliate", status: "active" as const, audience: {}, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" };

describe("AutonomousCampaignActionExecutor", () => {
  it("scales by scheduling at most one existing draft", async () => {
    let scheduled = 0;
    const executor = new AutonomousCampaignActionExecutor(
      { get: async () => campaign },
      { list: async () => [{ id: "content-1", campaignId: "c1", platform: "tiktok" as const, contentType: "affiliate-promotion", status: "draft" as const, createdAt: campaign.createdAt, updatedAt: campaign.updatedAt }] },
      { schedule: async (input: any) => { scheduled += 1; assert.equal(input.content.id, "content-1"); return { content: { ...input.content, status: "scheduled" }, account: {} as any, scheduledAt: input.scheduledAt, publishable: false }; } }
    );
    const result = await executor.execute({ campaignId: "c1", action: "scale", confidence: 0.9, reasons: ["evidence"] });
    assert.equal(result.mutated, true);
    assert.equal(scheduled, 1);
  });

  it("does not scale when no draft content exists", async () => {
    const executor = new AutonomousCampaignActionExecutor(
      { get: async () => campaign },
      { list: async () => [] },
      { schedule: async () => { throw new Error("must not schedule"); } }
    );
    const result = await executor.execute({ campaignId: "c1", action: "scale", confidence: 0.9, reasons: ["evidence"] });
    assert.equal(result.mutated, false);
  });
});
