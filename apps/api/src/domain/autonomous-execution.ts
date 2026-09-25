import type { AffiliateOffer, AudienceSegment, ContentPlatform, Product } from "@affiliateos/shared";
import { AutonomousOpportunitySelector, type OpportunityCandidateSource, type OpportunitySelectionPolicy, type OpportunitySelectionPoliciesByMarketplace, type OpportunitySelectionAudit } from "./autonomous-opportunity.js";
import type { AutonomousFeedbackProvider } from "./autonomous-feedback.js";
import type { CampaignOrchestrator, CampaignOrchestrationResult } from "./campaign-orchestrator.js";
import { scoreOpportunity, type ScoredOpportunity } from "./opportunity-scoring.js";
import type { AutonomousRunService } from "./autonomous-run-service.js";
import type { AutonomousDecisionAuditRepository } from "./autonomous-decision-audit.js";
import { AdaptiveExplorationPolicyProvider, type AdaptiveExplorationPolicy } from "./adaptive-exploration-policy.js";

export type AutonomousExecutionInput = {
  candidates: OpportunityCandidateSource[];
  policy?: OpportunitySelectionPolicy;
  policiesByMarketplace?: OpportunitySelectionPoliciesByMarketplace;
  audience?: AudienceSegment[];
  platforms?: ContentPlatform[];
  scheduledAt?: string;
  idempotencyNamespace?: string;
};
export type AutonomousExecutionOutcome = { productId: string; offerId?: string; score: number; status: "completed" | "failed"; idempotencyKey: string; result?: CampaignOrchestrationResult; error?: string };
export type AutonomousExecutionResult = { selected: ScoredOpportunity[]; rejected: Array<{ productId: string; score: number; reasons: string[] }>; audit: OpportunitySelectionAudit[]; outcomes: AutonomousExecutionOutcome[]; recoveredRunCount?: number };
const executionKey = (namespace: string, opportunity: ScoredOpportunity): string => `${namespace}:${opportunity.product.id}:${opportunity.offerId ?? "no-offer"}`;

export class AutonomousExecutionService {
  constructor(private readonly selector: AutonomousOpportunitySelector, private readonly orchestrator: CampaignOrchestrator, private readonly feedback?: AutonomousFeedbackProvider, private readonly autonomousRuns?: AutonomousRunService, private readonly decisionAudits?: AutonomousDecisionAuditRepository, private readonly adaptiveExploration?: AdaptiveExplorationPolicyProvider) {}

  async runOnce(input: AutonomousExecutionInput): Promise<AutonomousExecutionResult> {
    const namespace = input.idempotencyNamespace?.trim() || "autonomous-execution";
    const performance = this.feedback ? await this.feedback.getSignals({ observationKey: namespace }) : new Map();
    const recoveredKeys = new Set<string>();
    let recoveredRunCount = 0;
    if (this.autonomousRuns) {
      const recoverable = await this.autonomousRuns.listRecoverable();
      for (const run of recoverable) {
        const candidate = input.candidates.find((item) => item.product.id === run.opportunityProductId);
        const offer = candidate?.offers.find((item) => item.id === run.offerId);
        if (!candidate || !offer) continue;
        if (candidate.product.id !== run.opportunityProductId || candidate.product.status !== "active") continue;
        const performanceSignal = performance.get(candidate.product.marketplaceId + ":" + candidate.product.id) ?? performance.get(candidate.product.id);
        if (performanceSignal?.anomaly === "halt" || performanceSignal?.anomalyRecovery === "recovering") continue;
        const context = run.executionContext;
        // Recovery must honor the offer originally bound to the run. Re-ranking all
        // current offers could silently abandon a valid in-flight execution when a
        // different offer becomes the current best.
        const scored = scoreOpportunity({ product: candidate.product, offers: [offer], audience: context?.audience ?? input.audience });
        if (scored.offerId !== run.offerId) continue;
        const opportunity: ScoredOpportunity = scored;
        try {
          await this.orchestrator.execute({ opportunity, offer, product: candidate.product, audience: context?.audience ?? input.audience, platforms: context?.platforms ?? input.platforms, scheduledAt: context?.scheduledAt ?? input.scheduledAt, idempotencyKey: run.idempotencyKey });
          recoveredKeys.add(run.idempotencyKey);
          recoveredRunCount += 1;
        } catch {
          // Keep the run recoverable for a later cycle; the orchestrator records the failure state.
        }
      }
    }
    const adaptiveExplorationRates = this.adaptiveExploration
      ? await this.adaptiveExploration.getRates(input.candidates, input.policy ?? {}, input.policiesByMarketplace ?? {}, performance)
      : new Map<string, number>();
    const selection = this.selector.select(input.candidates, input.policy, performance, input.policiesByMarketplace, adaptiveExplorationRates);
    const auditByProductId = new Map<string, OpportunitySelectionAudit>();
    if (this.decisionAudits) {
      const createdAt = new Date().toISOString();
      const audits = selection.audit.map((audit) => {
        const signal = performance.get(audit.marketplaceId + ":" + audit.productId) ?? performance.get(audit.productId);
        return {
          ...audit,
          cycleId: namespace,
          createdAt,
          performanceRegime: signal?.regime,
          performanceRegimeConfidence: signal?.regimeConfidence,
          recovery: signal ? {
            anomaly: signal.anomaly ?? "none",
            recoveryState: signal.anomalyRecovery ?? "none",
            recoveryClicks: signal.recoveryClicks ?? 0,
            recoveryEvidenceScore: signal.recoveryEvidenceScore ?? 0,
            recoveryEpisodeId: signal.recoveryEpisodeId,
            episodeMetrics: signal.recoveryEpisodeMetrics,
            policy: signal.recoveryPolicy
          } : undefined
        };
      });
      await this.decisionAudits.saveMany(audits);
      for (const audit of audits) auditByProductId.set(audit.productId, audit);
    }
    const candidatesByOpportunity = new Map(
      input.candidates.flatMap((candidate) =>
        candidate.offers.map((offer) => [`${candidate.product.id}:${offer.id}`, { candidate, offer }] as const)
      )
    );
    const outcomes: AutonomousExecutionOutcome[] = [];
    for (const opportunity of selection.selected) {
      const performanceSignal = performance.get(opportunity.product.marketplaceId + ":" + opportunity.product.id) ?? performance.get(opportunity.product.id);
      if (performanceSignal?.anomaly === "halt") {
        const idempotencyKey = executionKey(namespace, opportunity);
        const error = "Autonomous execution blocked by active performance anomaly cooldown.";
        outcomes.push({ productId: opportunity.product.id, offerId: opportunity.offerId, score: opportunity.score, status: "failed", idempotencyKey, error });
        const audit = auditByProductId.get(opportunity.product.id);
        if (audit && this.decisionAudits) {
          await this.decisionAudits.updateOutcome(audit.auditId, {
            offerId: opportunity.offerId,
            status: "failed",
            error,
            observedAt: new Date().toISOString()
          });
        }
        continue;
      }
      const idempotencyKey = executionKey(namespace, opportunity);
      if (recoveredKeys.has(idempotencyKey)) continue;
      const resolved = opportunity.offerId
        ? candidatesByOpportunity.get(`${opportunity.product.id}:${opportunity.offerId}`)
        : undefined;
      const candidate = resolved?.candidate;
      const offer = resolved?.offer;
      if (!offer) {
        const error = "Selected opportunity has no matching affiliate offer.";
        outcomes.push({ productId: opportunity.product.id, offerId: opportunity.offerId, score: opportunity.score, status: "failed", idempotencyKey, error });
        const audit = auditByProductId.get(opportunity.product.id);
        if (audit && this.decisionAudits) await this.decisionAudits.updateOutcome(audit.auditId, { offerId: opportunity.offerId, status: "failed", error, observedAt: new Date().toISOString() });
        continue;
      }
      try {
        const result = await this.orchestrator.execute({ opportunity, offer, product: opportunity.product, audience: input.audience, platforms: input.platforms, scheduledAt: input.scheduledAt, idempotencyKey });
        outcomes.push({ productId: opportunity.product.id, offerId: offer.id, score: opportunity.score, status: "completed", idempotencyKey, result });
        const audit = auditByProductId.get(opportunity.product.id);
        if (audit && this.decisionAudits) await this.decisionAudits.updateOutcome(audit.auditId, { offerId: offer.id, status: "completed", campaignId: result.campaign.id, observedAt: new Date().toISOString() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcomes.push({ productId: opportunity.product.id, offerId: offer.id, score: opportunity.score, status: "failed", idempotencyKey, error: message });
        const audit = auditByProductId.get(opportunity.product.id);
        if (audit && this.decisionAudits) await this.decisionAudits.updateOutcome(audit.auditId, { offerId: offer.id, status: "failed", error: message, observedAt: new Date().toISOString() });
      }
    }
    return { selected: selection.selected, rejected: selection.rejected, audit: selection.audit, outcomes, recoveredRunCount };
  }
}
export type AutonomousExecutionCandidate = OpportunityCandidateSource & { product: Product; offers: AffiliateOffer[] };
