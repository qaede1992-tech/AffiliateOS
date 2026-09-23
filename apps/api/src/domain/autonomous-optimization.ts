import type { AnalyticsService, CampaignAnalytics } from "./analytics.js";
import type { AutonomousFeedbackProvider } from "./autonomous-feedback.js";
import {
  OptimizationEngine,
  type OptimizationPolicy,
  type OptimizationRecommendation,
  type OptimizationState
} from "./optimization-engine.js";

export interface OptimizationStateReader {
  get(campaignId: string): Promise<OptimizationState | undefined>;
}

export interface OptimizationStateWriter {
  save(campaignId: string, state: OptimizationState): Promise<OptimizationState>;
}

export class InMemoryOptimizationStateReader implements OptimizationStateReader {
  constructor(protected readonly state: Map<string, OptimizationState> = new Map()) {}

  async get(campaignId: string): Promise<OptimizationState | undefined> {
    return this.state.get(campaignId);
  }
}

export class InMemoryOptimizationStateStore extends InMemoryOptimizationStateReader implements OptimizationStateWriter {
  async save(campaignId: string, state: OptimizationState): Promise<OptimizationState> {
    this.state.set(campaignId, state);
    return state;
  }
}

export type AutonomousOptimizationResult = {
  campaigns: CampaignAnalytics[];
  recommendations: OptimizationRecommendation[];
};

/**
 * Decision-only boundary between measured campaign performance and autonomous execution.
 * It deliberately does not mutate campaigns, content, publishers, or marketplace state.
 */
export class AutonomousOptimizationService {
  private readonly engine: OptimizationEngine;

  constructor(
    private readonly analytics: Pick<AnalyticsService, "overview">,
    policy: OptimizationPolicy = {},
    private readonly state: OptimizationStateReader = new InMemoryOptimizationStateReader(),
    private readonly feedback?: AutonomousFeedbackProvider
  ) {
    this.engine = new OptimizationEngine(policy);
  }

  async recommend(now = new Date()): Promise<AutonomousOptimizationResult> {
    const overview = await this.analytics.overview();
    const state = new Map<string, OptimizationState>();
    for (const campaign of overview.campaigns) {
      const previous = await this.state.get(campaign.campaignId);
      if (previous) state.set(campaign.campaignId, previous);
    }

    const recommendations = this.engine.recommend(overview.campaigns, state, now);
    if (!this.feedback) {
      return { campaigns: overview.campaigns, recommendations };
    }

    const performance = await this.feedback.getSignals({ observationKey: "autonomous-optimization" });
    const guardedRecommendations = recommendations.map((recommendation) => {
      const campaign = overview.campaigns.find((item) => item.campaignId === recommendation.campaignId);
      const signal = campaign?.productId && campaign.marketplaceId
        ? performance.get(campaign.marketplaceId + ":" + campaign.productId) ?? performance.get(campaign.productId)
        : undefined;
      if (signal?.anomaly === "halt") {
        return {
          ...recommendation,
          action: "maintain" as const,
          confidence: Math.min(recommendation.confidence, 0.5),
          reasons: [
            "Optimization action held because the associated product is under an active performance anomaly halt.",
            "Wait for the anomaly cooldown and fresh evidence before changing campaign distribution or content."
          ]
        };
      }
      if (signal?.anomalyRecovery === "recovering") {
        return {
          ...recommendation,
          action: "maintain" as const,
          confidence: Math.min(recommendation.confidence, 0.5),
          reasons: [
            "Optimization action held while the associated product is recovering from a performance anomaly.",
            "Scale, pause, and content changes remain blocked until the recovery evidence gate is satisfied."
          ]
        };
      }
      return recommendation;
    });

    return { campaigns: overview.campaigns, recommendations: guardedRecommendations };
  }
}
