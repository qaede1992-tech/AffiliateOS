import type { CampaignAnalytics } from "./analytics.js";

export type OptimizationAction =
  | "scale"
  | "maintain"
  | "revise-content"
  | "pause";

export type OptimizationRecommendation = {
  campaignId: string;
  action: OptimizationAction;
  confidence: number;
  reasons: string[];
};

export type OptimizationPolicy = {
  minClicksForDecision?: number;
  cooldownMs?: number;
  scaleConversionRate?: number;
  pauseConversionRate?: number;
  pauseAfterClicks?: number;
};

export type OptimizationState = { action: OptimizationAction; appliedAt: string };

export class OptimizationEngine {
  constructor(private readonly policy: OptimizationPolicy = {}) {}

  recommend(campaigns: CampaignAnalytics[], state: Map<string, OptimizationState> = new Map(), now = new Date()): OptimizationRecommendation[] {
    const minClicks = this.policy.minClicksForDecision ?? 20;
    const scaleRate = this.policy.scaleConversionRate ?? 0.05;
    const pauseRate = this.policy.pauseConversionRate ?? 0.01;
    const pauseAfterClicks = this.policy.pauseAfterClicks ?? 100;
    const cooldownMs = this.policy.cooldownMs ?? 60 * 60_000;

    return campaigns.map((campaign) => {
      const previous = state.get(campaign.campaignId);
      if (previous && now.getTime() - Date.parse(previous.appliedAt) < cooldownMs) {
        return { campaignId: campaign.campaignId, action: "maintain", confidence: 0.5, reasons: [`Optimization cooldown active after ${previous.action}.`] };
      }
      if (campaign.clickCount < minClicks) {
        return { campaignId: campaign.campaignId, action: "maintain", confidence: 0.25, reasons: ["Insufficient click volume for a reliable optimization decision."] };
      }
      if (campaign.conversionRate >= scaleRate) {
        return { campaignId: campaign.campaignId, action: "scale", confidence: Math.min(1, campaign.conversionRate / Math.max(scaleRate, Number.EPSILON)), reasons: ["Conversion rate is at or above the scale threshold.", "Continue distributing this campaign while preserving measurement."] };
      }
      if (campaign.clickCount >= pauseAfterClicks && campaign.conversionRate <= pauseRate) {
        return { campaignId: campaign.campaignId, action: "pause", confidence: 0.8, reasons: ["High click volume has not produced sufficient attributed conversions.", "Pause additional distribution and feed the campaign into content/opportunity revision."] };
      }
      return { campaignId: campaign.campaignId, action: "revise-content", confidence: 0.6, reasons: ["Traffic exists but conversion performance is below the scale threshold.", "Test new creative, audience framing, or offer positioning before increasing distribution."] };
    });
  }
}
