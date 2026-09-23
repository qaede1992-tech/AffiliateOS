import { DomainError } from "./errors.js";
import type { Campaign } from "@affiliateos/shared";
import type { CampaignService } from "./campaigns.js";
import type { ContentService } from "./content.js";
import type { DistributionEngine } from "./distribution-engine.js";
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
  constructor(
    private readonly campaigns: Pick<CampaignService, "get" | "update">,
    private readonly content?: Pick<ContentService, "list" | "update">,
    private readonly distribution?: Pick<DistributionEngine, "schedule">
  ) {}

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
      case "scale": {
        if (!this.content || !this.distribution) return { campaignId: campaign.id, action: recommendation.action, campaign, mutated: false };
        if (campaign.status !== "scheduled" && campaign.status !== "active") return { campaignId: campaign.id, action: recommendation.action, campaign, mutated: false };
        const drafts = (await this.content.list(campaign.id)).filter((item) => item.status === "draft");
        const draft = drafts[0];
        if (!draft) return { campaignId: campaign.id, action: recommendation.action, campaign, mutated: false };
        const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
        await this.distribution.schedule({ content: draft, scheduledAt });
        return { campaignId: campaign.id, action: recommendation.action, campaign, mutated: true };
      }
      case "revise-content": {
        if (!this.content) return { campaignId: campaign.id, action: recommendation.action, campaign, mutated: false };
        const scheduled = (await this.content.list(campaign.id)).filter((item) => item.status === "scheduled");
        const candidate = scheduled[0];
        if (!candidate) return { campaignId: campaign.id, action: recommendation.action, campaign, mutated: false };
        const updatedContent = await this.content.update(candidate.id, { status: "draft", scheduledAt: undefined, socialAccountId: undefined });
        if (updatedContent.status !== "draft") throw new DomainError("AUTONOMOUS_REVISION_NOT_STAGED", "Autonomous content revision could not be staged as a draft.");
        return { campaignId: campaign.id, action: recommendation.action, campaign, mutated: true };
      }
      case "maintain":
        return { campaignId: campaign.id, action: recommendation.action, campaign, mutated: false };
      default:
        throw new DomainError("UNSUPPORTED_AUTONOMOUS_ACTION", "Unsupported autonomous campaign action.");
    }
  }
}
