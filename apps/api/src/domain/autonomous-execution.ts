import type { AffiliateOffer, AudienceSegment, ContentPlatform, Product } from "@affiliateos/shared";
import { AutonomousOpportunitySelector, type OpportunityCandidateSource, type OpportunitySelectionPolicy } from "./autonomous-opportunity.js";
import type { AutonomousFeedbackProvider } from "./autonomous-feedback.js";
import type { CampaignOrchestrator, CampaignOrchestrationResult } from "./campaign-orchestrator.js";
import { scoreOpportunity, type ScoredOpportunity } from "./opportunity-scoring.js";
import type { AutonomousRunService } from "./autonomous-run-service.js";

export type AutonomousExecutionInput = {
  candidates: OpportunityCandidateSource[];
  policy?: OpportunitySelectionPolicy;
  audience?: AudienceSegment[];
  platforms?: ContentPlatform[];
  scheduledAt?: string;
  idempotencyNamespace?: string;
};
export type AutonomousExecutionOutcome = { productId: string; offerId?: string; score: number; status: "completed" | "failed"; idempotencyKey: string; result?: CampaignOrchestrationResult; error?: string };
export type AutonomousExecutionResult = { selected: ScoredOpportunity[]; rejected: Array<{ productId: string; score: number; reasons: string[] }>; outcomes: AutonomousExecutionOutcome[]; recoveredRunCount?: number };
const executionKey = (namespace: string, opportunity: ScoredOpportunity): string => `${namespace}:${opportunity.product.id}:${opportunity.offerId ?? "no-offer"}`;

export class AutonomousExecutionService {
  constructor(private readonly selector: AutonomousOpportunitySelector, private readonly orchestrator: CampaignOrchestrator, private readonly feedback?: AutonomousFeedbackProvider, private readonly autonomousRuns?: AutonomousRunService) {}

  async runOnce(input: AutonomousExecutionInput): Promise<AutonomousExecutionResult> {
    const namespace = input.idempotencyNamespace?.trim() || "autonomous-execution";
    const recoveredKeys = new Set<string>();
    let recoveredRunCount = 0;
    if (this.autonomousRuns) {
      const recoverable = await this.autonomousRuns.listRecoverable();
      for (const run of recoverable) {
        const candidate = input.candidates.find((item) => item.product.id === run.opportunityProductId);
        const offer = candidate?.offers.find((item) => item.id === run.offerId);
        if (!candidate || !offer) continue;
        const scored = scoreOpportunity({ product: candidate.product, offers: candidate.offers, audience: input.audience });
        const opportunity: ScoredOpportunity = { ...scored, offerId: run.offerId };
        try {
          const result = await this.orchestrator.execute({ opportunity, offer, product: candidate.product, audience: input.audience, platforms: input.platforms, scheduledAt: input.scheduledAt, idempotencyKey: run.idempotencyKey });
          recoveredKeys.add(run.idempotencyKey);
          recoveredRunCount += 1;
        } catch {
          // Keep the run recoverable for a later cycle; the orchestrator records the failure state.
        }
      }
    }
    const performance = this.feedback ? await this.feedback.getSignals({ observationKey: namespace }) : new Map();
    const selection = this.selector.select(input.candidates, input.policy, performance);
    const candidatesByProduct = new Map(input.candidates.map((candidate) => [candidate.product.id, candidate]));
    const outcomes: AutonomousExecutionOutcome[] = [];
    for (const opportunity of selection.selected) {
      const idempotencyKey = executionKey(namespace, opportunity);
      if (recoveredKeys.has(idempotencyKey)) continue;
      const candidate = candidatesByProduct.get(opportunity.product.id);
      const offer = candidate?.offers.find((item) => item.id === opportunity.offerId);
      if (!offer) { outcomes.push({ productId: opportunity.product.id, offerId: opportunity.offerId, score: opportunity.score, status: "failed", idempotencyKey, error: "Selected opportunity has no matching affiliate offer." }); continue; }
      try {
        const result = await this.orchestrator.execute({ opportunity, offer, product: opportunity.product, audience: input.audience, platforms: input.platforms, scheduledAt: input.scheduledAt, idempotencyKey });
        outcomes.push({ productId: opportunity.product.id, offerId: offer.id, score: opportunity.score, status: "completed", idempotencyKey, result });
      } catch (error) {
        outcomes.push({ productId: opportunity.product.id, offerId: offer.id, score: opportunity.score, status: "failed", idempotencyKey, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { selected: selection.selected, rejected: selection.rejected, outcomes, recoveredRunCount };
  }
}
export type AutonomousExecutionCandidate = OpportunityCandidateSource & { product: Product; offers: AffiliateOffer[] };
