import type { AnalyticsService, CampaignAnalytics } from "./analytics.js";
import type { AutonomousCampaignActionResult, AutonomousCampaignActionExecutor } from "./autonomous-campaign-action-executor.js";
import type { OptimizationStateReader, OptimizationStateWriter } from "./autonomous-optimization.js";
import type { AutonomousActionMetrics, AutonomousActionOutcomeWriter } from "./autonomous-action-outcome.js";
import type { AutonomousFeedbackProvider } from "./autonomous-feedback.js";
import { OptimizationEngine, type OptimizationPolicy, type OptimizationRecommendation, type OptimizationState } from "./optimization-engine.js";

export type AutonomousOptimizationRunResult = {
  campaigns: CampaignAnalytics[];
  recommendations: OptimizationRecommendation[];
  actions: AutonomousCampaignActionResult[];
};

export class AutonomousOptimizationRunner {
  private readonly engine: OptimizationEngine;

  constructor(
    private readonly analytics: Pick<AnalyticsService, "overview" | "campaign">,
    private readonly stateReader: OptimizationStateReader,
    private readonly stateWriter: OptimizationStateWriter,
    private readonly executor: AutonomousCampaignActionExecutor,
    private readonly outcomeWriter?: AutonomousActionOutcomeWriter,
    policy: OptimizationPolicy = {},
    private readonly actionOutcomeEvaluationDelayMs = 24 * 60 * 60_000,
    private readonly feedback?: AutonomousFeedbackProvider
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

    const evaluations = await this.evaluateDueActionOutcomes(overview.campaigns, now);
    for (const [campaignId, evaluation] of evaluations) {
      const previous = state.get(campaignId);
      if (previous) state.set(campaignId, { ...previous, evaluation });
    }

    const recommendations = this.engine.recommend(overview.campaigns, state, now);
    const performance = this.feedback ? await this.feedback.getSignals({ observationKey: "autonomous-optimization-actions" }) : undefined;
    const actions: AutonomousCampaignActionResult[] = [];
    for (const recommendation of recommendations) {
      if (recommendation.action === "maintain") continue;
      const baseline = toActionMetrics(overview.campaigns.find((campaign) => campaign.campaignId === recommendation.campaignId));
      const result = await this.executor.execute(recommendation);
      actions.push(result);
      if (result.outcomeId && this.outcomeWriter?.updateRecovery && performance) {
        const campaign = overview.campaigns.find((item) => item.campaignId === recommendation.campaignId);
        const signal = campaign?.productId && campaign.marketplaceId
          ? performance.get(campaign.marketplaceId + ":" + campaign.productId) ?? performance.get(campaign.productId)
          : undefined;
        if (signal) {
          try {
            await this.outcomeWriter.updateRecovery(result.outcomeId, {
              state: signal.anomalyRecovery ?? "none",
              evidenceScore: signal.recoveryEvidenceScore ?? 0,
              episodeId: signal.recoveryEpisodeId,
              policy: signal.recoveryPolicy
            });
          } catch {
            // Recovery context is advisory enrichment; the action outcome remains durable.
          }
        }
      }
      if (result.outcomeId && this.outcomeWriter?.updateMetrics) {
        try {
          const observed = toActionMetrics(await this.analytics.campaign(recommendation.campaignId));
          await this.outcomeWriter.updateMetrics(result.outcomeId, { baseline, observed });
        } catch {
          // The action outcome is already persisted. Analytics enrichment must not
          // turn a completed autonomous action into a failed action.
        }
      }
      await this.stateWriter.save(recommendation.campaignId, {
        action: recommendation.action,
        appliedAt: now.toISOString()
      });
    }

    return { campaigns: overview.campaigns, recommendations, actions };
  }

  private async evaluateDueActionOutcomes(campaigns: CampaignAnalytics[], now: Date): Promise<Map<string, NonNullable<OptimizationState["evaluation"]>>> {
    const evaluations = new Map<string, NonNullable<OptimizationState["evaluation"]>>();
    if (!this.outcomeWriter?.latestByCampaign || !this.outcomeWriter.updateEvaluation) return evaluations;
    for (const campaign of campaigns) {
      try {
        const outcome = await this.outcomeWriter.latestByCampaign(campaign.campaignId);
        if (!outcome || outcome.status !== "mutated" || outcome.evaluatedAt) continue;
        const observedAt = Date.parse(outcome.observedAt);
        if (!Number.isFinite(observedAt) || now.getTime() - observedAt < this.actionOutcomeEvaluationDelayMs) continue;
        const current = toActionMetrics(campaign);
        if (!current) continue;
        await this.outcomeWriter.updateEvaluation(outcome.id, current, now.toISOString());
        const baselineRate = outcome.baseline?.conversionRate ?? outcome.observed?.conversionRate;
        const baselineCommissionPerClick = outcome.baseline && outcome.baseline.clickCount > 0
          ? outcome.baseline.attributedCommissionCents / outcome.baseline.clickCount
          : outcome.observed && outcome.observed.clickCount > 0
            ? outcome.observed.attributedCommissionCents / outcome.observed.clickCount
            : 0;
        const currentCommissionPerClick = current.clickCount > 0 ? current.attributedCommissionCents / current.clickCount : 0;
        evaluations.set(campaign.campaignId, {
          outcomeId: outcome.id,
          evaluatedAt: now.toISOString(),
          conversionRateDelta: current.conversionRate - (baselineRate ?? current.conversionRate),
          commissionPerClickDeltaCents: currentCommissionPerClick - baselineCommissionPerClick
        });
      } catch {
        // Evaluation is observational. A transient analytics/persistence failure
        // must not block the next autonomous optimization cycle.
      }
    }
    return evaluations;
  }
}

function toActionMetrics(campaign?: CampaignAnalytics): AutonomousActionMetrics | undefined {
  if (!campaign) return undefined;
  return {
    clickCount: campaign.clickCount,
    attributedConversionCount: campaign.attributedConversionCount,
    attributedRevenueCents: campaign.attributedRevenueCents,
    attributedCommissionCents: campaign.attributedCommissionCents,
    conversionRate: campaign.conversionRate
  };
}
