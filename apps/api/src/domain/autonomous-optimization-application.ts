import type { CampaignAnalytics } from "./analytics.js";
import { OptimizationEngine, type OptimizationPolicy, type OptimizationRecommendation, type OptimizationState } from "./optimization-engine.js";
import type { OptimizationStateReader, OptimizationStateWriter } from "./autonomous-optimization.js";

export type OptimizationApplicationResult = {
  recommendations: OptimizationRecommendation[];
  applied: OptimizationRecommendation[];
};

export class AutonomousOptimizationApplicationService {
  private readonly engine: OptimizationEngine;

  constructor(
    private readonly stateReader: OptimizationStateReader,
    private readonly stateWriter: OptimizationStateWriter,
    policy: OptimizationPolicy = {}
  ) {
    this.engine = new OptimizationEngine(policy);
  }

  async evaluate(campaigns: CampaignAnalytics[], now = new Date()): Promise<OptimizationApplicationResult> {
    const state = new Map<string, OptimizationState>();
    for (const campaign of campaigns) {
      const previous = await this.stateReader.get(campaign.campaignId);
      if (previous) state.set(campaign.campaignId, previous);
    }

    const recommendations = this.engine.recommend(campaigns, state, now);
    const applied: OptimizationRecommendation[] = [];
    for (const recommendation of recommendations) {
      if (recommendation.action === "maintain") continue;
      const persisted = await this.stateWriter.save(recommendation.campaignId, {
        action: recommendation.action,
        appliedAt: now.toISOString()
      });
      if (persisted.action === recommendation.action) applied.push(recommendation);
    }
    return { recommendations, applied };
  }
}
