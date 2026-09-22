import assert from "node:assert/strict";
import test from "node:test";
import type { Campaign } from "@affiliateos/shared";
import { AutonomousCampaignActionExecutor } from "../src/domain/autonomous-campaign-action-executor.js";
import type { OptimizationRecommendation } from "../src/domain/optimization-engine.js";

const recommendation = (action: OptimizationRecommendation["action"]): OptimizationRecommendation => ({
  campaignId: "00000000-0000-0000-0000-000000000001",
  action,
  confidence: 0.9,
  reasons: ["test"]
});

function fixture(status: Campaign["status"]) {
  const campaign = { id: recommendation("pause").campaignId, status } as Campaign;
  let updates = 0;
  return {
    campaign,
    service: {
      async get() { return campaign; },
      async update(_id: string, input: { status?: Campaign["status"] }) {
        updates += 1;
        campaign.status = input.status ?? campaign.status;
        return campaign;
      }
    },
    updates: () => updates
  };
}

test("autonomous pause transitions active campaigns to paused", async () => {
  const f = fixture("active");
  const result = await new AutonomousCampaignActionExecutor(f.service).execute(recommendation("pause"));
  assert.equal(result.campaign.status, "paused");
  assert.equal(result.mutated, true);
  assert.equal(f.updates(), 1);
});

test("autonomous pause transitions scheduled campaigns to paused", async () => {
  const f = fixture("scheduled");
  const result = await new AutonomousCampaignActionExecutor(f.service).execute(recommendation("pause"));
  assert.equal(result.campaign.status, "paused");
  assert.equal(result.mutated, true);
});

test("replaying pause on an already paused campaign is idempotent", async () => {
  const f = fixture("paused");
  const result = await new AutonomousCampaignActionExecutor(f.service).execute(recommendation("pause"));
  assert.equal(result.mutated, false);
  assert.equal(f.updates(), 0);
});

test("autonomous pause fails closed for draft campaigns", async () => {
  const f = fixture("draft");
  await assert.rejects(
    () => new AutonomousCampaignActionExecutor(f.service).execute(recommendation("pause")),
    /scheduled or active campaign/i
  );
  assert.equal(f.updates(), 0);
});

test("scale remains a decision until a campaign scaling capability exists", async () => {
  const f = fixture("active");
  const result = await new AutonomousCampaignActionExecutor(f.service).execute(recommendation("scale"));
  assert.equal(result.mutated, false);
  assert.equal(result.campaign.status, "active");
  assert.equal(f.updates(), 0);
});

test("revise-content remains a decision until content revision is explicitly supported", async () => {
  const f = fixture("active");
  const result = await new AutonomousCampaignActionExecutor(f.service).execute(recommendation("revise-content"));
  assert.equal(result.mutated, false);
  assert.equal(f.updates(), 0);
});
