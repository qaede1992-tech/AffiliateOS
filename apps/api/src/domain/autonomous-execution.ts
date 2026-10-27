import type { AffiliateOffer, AudienceSegment, ContentPlatform, Product } from "@affiliateos/shared";
import { AutonomousOpportunitySelector, isExecutableAffiliateOffer, type OpportunityCandidateSource, type OpportunitySelectionPolicy, type OpportunitySelectionPoliciesByMarketplace, type OpportunitySelectionAudit } from "./autonomous-opportunity.js";
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
  requirePublishableMedia?: boolean;
  /** When false, autonomous runs may create drafts but must not schedule publication. */
  publicationEnabled?: boolean;
  requireCommissionSignal?: boolean;
  /** Maximum products per automatically grouped story; set to 1 to disable grouping. */
  storyMaxProducts?: number;
};
export type AutonomousExecutionOutcome = { productId: string; offerId?: string; score: number; status: "completed" | "failed"; idempotencyKey: string; result?: CampaignOrchestrationResult; error?: string };
export type AutonomousExecutionResult = { selected: ScoredOpportunity[]; rejected: Array<{ productId: string; score: number; reasons: string[] }>; audit: OpportunitySelectionAudit[]; outcomes: AutonomousExecutionOutcome[]; recoveredRunCount?: number };
const executionKey = (namespace: string, opportunity: ScoredOpportunity): string => `${namespace}:${opportunity.product.id}:${opportunity.offerId ?? "no-offer"}`;

export class AutonomousExecutionService {
  constructor(private readonly selector: AutonomousOpportunitySelector, private readonly orchestrator: CampaignOrchestrator, private readonly feedback?: AutonomousFeedbackProvider, private readonly autonomousRuns?: AutonomousRunService, private readonly decisionAudits?: AutonomousDecisionAuditRepository, private readonly adaptiveExploration?: AdaptiveExplorationPolicyProvider) {}

  async previewSelection(input: Omit<AutonomousExecutionInput, "candidates"> & { candidates: OpportunityCandidateSource[] }): Promise<Pick<AutonomousExecutionResult, "selected" | "rejected" | "audit">> {
    const namespace = input.idempotencyNamespace?.trim() || "autonomous-preview";
    const candidates = this.autonomousRuns
      ? await Promise.all(input.candidates.map(async (candidate) => ({
          ...candidate,
          offers: (await Promise.all(candidate.offers.map(async (candidateOffer) =>
            await this.autonomousRuns!.hasCompletedOpportunity(candidate.product.id, candidateOffer.id)
              ? undefined
              : candidateOffer
          ))).filter((candidateOffer): candidateOffer is AffiliateOffer => candidateOffer !== undefined)
        })))
      : input.candidates;
    const performance = this.feedback ? await this.feedback.getSignals({ observationKey: namespace }) : new Map();
    const adaptiveExplorationRates = this.adaptiveExploration
      ? await this.adaptiveExploration.getRates(candidates, input.policy ?? {}, input.policiesByMarketplace ?? {}, performance)
      : new Map<string, number>();
    const selection = this.selector.select(
      candidates,
      { ...input.policy, requirePublishableMedia: input.requirePublishableMedia ?? input.policy?.requirePublishableMedia, requireCommissionSignal: input.requireCommissionSignal ?? input.policy?.requireCommissionSignal },
      performance,
      input.policiesByMarketplace,
      adaptiveExplorationRates
    );
    return { selected: selection.selected, rejected: selection.rejected, audit: selection.audit };
  }

  async runOnce(input: AutonomousExecutionInput): Promise<AutonomousExecutionResult> {
    const storyMaxProducts = input.storyMaxProducts ?? 3;
    if (!Number.isInteger(storyMaxProducts) || storyMaxProducts < 1 || storyMaxProducts > 10) {
      throw new Error("storyMaxProducts must be an integer between 1 and 10.");
    }
    const namespace = input.idempotencyNamespace?.trim() || "autonomous-execution";
    const performance = this.feedback ? await this.feedback.getSignals({ observationKey: namespace }) : new Map();
    const recoveredKeys = new Set<string>();
    const recoveredOpportunityKeys = new Set<string>();
    let recoveredRunCount = 0;
    if (this.autonomousRuns) {
      const recoverable = await this.autonomousRuns.listRecoverable();
      for (const run of recoverable) {
        const candidate = input.candidates.find((item) => item.product.id === run.opportunityProductId);
        if (!candidate) continue;
        const offer = candidate.offers.find((item) => item.id === run.offerId);
        if (!offer) {
          await this.autonomousRuns.markUnrecoverable(run.id, "The original affiliate offer is no longer available under the active marketplace account.");
          continue;
        }
        if (candidate.product.id !== run.opportunityProductId || candidate.product.status !== "active" || !isExecutableAffiliateOffer(candidate.product.id, offer)) {
          await this.autonomousRuns.markUnrecoverable(run.id, "The original product or affiliate offer is no longer eligible for autonomous execution.");
          continue;
        }
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
          await this.orchestrator.execute({ opportunity, offer, product: candidate.product, audience: context?.audience ?? input.audience, platforms: context?.platforms ?? input.platforms, scheduledAt: input.publicationEnabled === false ? undefined : (context?.scheduledAt ?? input.scheduledAt), idempotencyKey: run.idempotencyKey });
          recoveredKeys.add(run.idempotencyKey);
          recoveredOpportunityKeys.add(`${candidate.product.id}:${offer.id}`);
          recoveredRunCount += 1;
        } catch {
          // Keep the run recoverable for a later cycle; the orchestrator records the failure state.
        }
      }
    }
    const selectionCandidates = await Promise.all(input.candidates.map(async (candidate) => {
      const offers = await Promise.all(candidate.offers.map(async (candidateOffer) => {
        const key = `${candidate.product.id}:${candidateOffer.id}`;
        if (recoveredOpportunityKeys.has(key)) return undefined;
        if (this.autonomousRuns && await this.autonomousRuns.hasCompletedOpportunity(candidate.product.id, candidateOffer.id)) return undefined;
        return candidateOffer;
      }));
      return { ...candidate, offers: offers.filter((candidateOffer): candidateOffer is AffiliateOffer => candidateOffer !== undefined) };
    }));
    const adaptiveExplorationRates = this.adaptiveExploration
      ? await this.adaptiveExploration.getRates(selectionCandidates, input.policy ?? {}, input.policiesByMarketplace ?? {}, performance)
      : new Map<string, number>();
    const selection = this.selector.select(selectionCandidates, { ...input.policy, requirePublishableMedia: input.requirePublishableMedia ?? input.policy?.requirePublishableMedia, requireCommissionSignal: input.requireCommissionSignal ?? input.policy?.requireCommissionSignal }, performance, input.policiesByMarketplace, adaptiveExplorationRates);
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
      selectionCandidates.flatMap((candidate) =>
        candidate.offers.map((offer) => [`${candidate.product.id}:${offer.id}`, { candidate, offer }] as const)
      )
    );
    const outcomes: AutonomousExecutionOutcome[] = [];
    const executable: Array<{ opportunity: ScoredOpportunity; offer: AffiliateOffer; idempotencyKey: string }> = [];
    for (const opportunity of selection.selected) {
      const performanceSignal = performance.get(opportunity.product.marketplaceId + ":" + opportunity.product.id) ?? performance.get(opportunity.product.id);
      const idempotencyKey = executionKey(namespace, opportunity);
      if (performanceSignal?.anomaly === "halt") {
        const error = "Autonomous execution blocked by active performance anomaly cooldown.";
        outcomes.push({ productId: opportunity.product.id, offerId: opportunity.offerId, score: opportunity.score, status: "failed", idempotencyKey, error });
        const audit = auditByProductId.get(opportunity.product.id);
        if (audit && this.decisionAudits) await this.decisionAudits.updateOutcome(audit.auditId, { offerId: opportunity.offerId, status: "failed", error, observedAt: new Date().toISOString() });
        continue;
      }
      if (recoveredKeys.has(idempotencyKey)) continue;
      const resolved = opportunity.offerId
        ? candidatesByOpportunity.get(`${opportunity.product.id}:${opportunity.offerId}`)
        : undefined;
      const offer = resolved?.offer;
      if (!offer || !isExecutableAffiliateOffer(opportunity.product.id, offer)) {
        const error = !offer
          ? "Selected opportunity has no matching affiliate offer."
          : "Selected affiliate offer is not executable or is not bound to the selected product.";
        outcomes.push({ productId: opportunity.product.id, offerId: opportunity.offerId, score: opportunity.score, status: "failed", idempotencyKey, error });
        const audit = auditByProductId.get(opportunity.product.id);
        if (audit && this.decisionAudits) await this.decisionAudits.updateOutcome(audit.auditId, { offerId: opportunity.offerId, status: "failed", error, observedAt: new Date().toISOString() });
        continue;
      }
      executable.push({ opportunity, offer, idempotencyKey });
    }

    // Group only products with an explicit shared category and marketplace. Missing
    // categories stay single-product so unrelated items are never combined by guess.
    const grouped = new Map<string, typeof executable>();
    for (const item of executable) {
      const category = item.opportunity.product.category?.trim().toLowerCase();
      const key = category
        ? `${item.opportunity.product.marketplaceId}:category:${category}`
        : `product:${item.opportunity.product.id}`;
      const group = grouped.get(key) ?? [];
      group.push(item);
      grouped.set(key, group);
    }
    const executionGroups = [...grouped.values()].flatMap((group) => {
      const chunks: typeof executable[] = [];
      for (let index = 0; index < group.length; index += storyMaxProducts) {
        chunks.push(group.slice(index, index + storyMaxProducts));
      }
      return chunks;
    });

    for (const group of executionGroups) {
      const primary = group[0];
      if (!primary) continue;
      const storyProducts = group.slice(1).map((item, index) => ({
        product: item.opportunity.product,
        offer: item.offer,
        role: "recommendation" as const,
        position: index + 1
      }));
      try {
        const result = await this.orchestrator.execute({
          opportunity: primary.opportunity,
          offer: primary.offer,
          product: primary.opportunity.product,
          audience: input.audience,
          platforms: input.platforms,
          scheduledAt: input.publicationEnabled === false ? undefined : input.scheduledAt,
          idempotencyKey: primary.idempotencyKey,
          ...(storyProducts.length ? { storyProducts } : {})
        });
        for (const item of group) {
          outcomes.push({ productId: item.opportunity.product.id, offerId: item.offer.id, score: item.opportunity.score, status: "completed", idempotencyKey: item.idempotencyKey, result });
          const audit = auditByProductId.get(item.opportunity.product.id);
          if (audit && this.decisionAudits) await this.decisionAudits.updateOutcome(audit.auditId, { offerId: item.offer.id, status: "completed", campaignId: result.campaign.id, observedAt: new Date().toISOString() });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const item of group) {
          outcomes.push({ productId: item.opportunity.product.id, offerId: item.offer.id, score: item.opportunity.score, status: "failed", idempotencyKey: item.idempotencyKey, error: message });
          const audit = auditByProductId.get(item.opportunity.product.id);
          if (audit && this.decisionAudits) await this.decisionAudits.updateOutcome(audit.auditId, { offerId: item.offer.id, status: "failed", error: message, observedAt: new Date().toISOString() });
        }
      }
    }
    return { selected: selection.selected, rejected: selection.rejected, audit: selection.audit, outcomes, recoveredRunCount };
  }
}
export type AutonomousExecutionCandidate = OpportunityCandidateSource & { product: Product; offers: AffiliateOffer[] };
