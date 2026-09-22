import { DomainError } from "./errors.js";
import type { Campaign } from "@affiliateos/shared";
import type { CampaignService } from "./campaigns.js";
import type { OptimizationRecommendation } from "./optimization-engine.js";

export type AutonomousCampaignActionResult = {
  campaignId: string;
  action: OptimizationRecommendation["action"];
  campaign: Campaign;
  mutated: boolean;
};

/**
 * Guarded boundary for autonomous campaign actions.
 * Only transitions already permitted by CampaignService are used here.
 * Actions that require capabilities not represented by the campaign domain are
 * intentionally left as non-mutating decisions.
 */
export class AutonomousCampaignActionExecutor {
  constructor(private readonly campaigns: Pick<CampaignService, "get" | "update">) {}

  async execute(recommendation: OptimizationRecommendation): Promise<AutonomousCampaignActionResult> {
    const campaign = await this.campaigns.get(recommendation.campaignId);

    switch (recommendation.action) {
      case "pause": {
        if (campaign.status === "paused") {
          return { campaignId: campaign.id, action: recommendation.action, campaign, mutated: false };
        }
        if (campaign.status !== "scheduled" && campaign.status !== "active") {
          throw new DomainError(
            "INVALID_AUTONOMOUS_PAUSE",
            `Autonomous pause requires a scheduled or active campaign; received ${campaign.status}.`
          );
        }
        const updated = await this.campaigns.update(campaign.id, { status: "paused" });
        return { campaignId: campaign.id, action: recommendation.action, campaign: updated, mutated: true };
      }
      case "scale":
      case "revise-content":
      case "maintain":
        return { campaignId: campaign.id, action: recommendation.action, campaign, mutated: false };
      default:
        throw new DomainError("UNSUPPORTED_AUTONOMOUS_ACTION", "Unsupported autonomous campaign action.");
    }
  }
}
