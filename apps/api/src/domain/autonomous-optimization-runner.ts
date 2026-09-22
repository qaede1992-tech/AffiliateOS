import type { AnalyticsService, CampaignAnalytics } from "./analytics.js";
import type { AutonomousCampaignActionResult, AutonomousCampaignActionExecutor } from "./autonomous-campaign-action-executor.js";
import type { OptimizationStateReader, OptimizationStateWriter } from "./autonomous-optimization.js";
import { OptimizationEngine, type OptimizationPolicy, type OptimizationRecommendation, type OptimizationState } from "./optimization-engine.js";

export type AutonomousOptimizationRunResult = {
  campaigns: CampaignAnalytics[];
  recommendations: OptimizationRecommendation[];
  actions: AutonomousCampaignActionResult[];
};

export class AutonomousOptimizationRunner {
  private readonly engine: OptimizationEngine;

  constructor(
    private readonly analytics: Pick<AnalyticsService, "overview">,
    private readonly stateReader: OptimizationStateReader,
    private readonly stateWriter: OptimizationStateWriter,
    private readonly executor: AutonomousCampaignActionExecutor,
    policy: OptimizationPolicy = {}
  ) {
    this.engine = new OptimizationEngine(policy);
  }

  async run(now = new Date()): Promise<AutonomousOptimizationRunResult> {
    const overview = await this.analytics.overview();
    const state = new Map<string, OptimizationState>();
    for (const campaign of overview.campaigns) {
      const previous = await this.stateReader.get(campaign.campaignId);
      if (previous) state.set(campaign.campaignId, previous);
    }

    const recommendations = this.engine.recommend(overview.campaigns, state, now);
    const actions: AutonomousCampaignActionResult[] = [];
    for (const recommendation of recommendations) {
      if (recommendation.action === "maintain") continue;
      const result = await this.executor.execute(recommendation);
      actions.push(result);
      if (result.mutated) {
        await this.stateWriter.save(recommendation.campaignId, {
          action: recommendation.action,
          appliedAt: now.toISOString()
        });
      }
    }

    return { campaigns: overview.campaigns, recommendations, actions };
  }
}
