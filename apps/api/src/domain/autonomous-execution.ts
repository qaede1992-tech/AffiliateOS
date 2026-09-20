import type { AffiliateOffer, AudienceSegment, ContentPlatform, Product } from "@affiliateos/shared";
import { AutonomousOpportunitySelector, type OpportunityCandidateSource, type OpportunitySelectionPolicy } from "./autonomous-opportunity.js";
import type { CampaignOrchestrator, CampaignOrchestrationResult } from "./campaign-orchestrator.js";
import type { ScoredOpportunity } from "./opportunity-scoring.js";

export type AutonomousExecutionInput = {
  candidates: OpportunityCandidateSource[];
  policy?: OpportunitySelectionPolicy;
  audience?: AudienceSegment[];
  platforms?: ContentPlatform[];
  scheduledAt?: string;
  idempotencyNamespace?: string;
};

export type AutonomousExecutionOutcome = {
  productId: string;
  offerId?: string;
  score: number;
  status: "completed" | "failed";
  idempotencyKey: string;
  result?: CampaignOrchestrationResult;
  error?: string;
};

export type AutonomousExecutionResult = {
  selected: ScoredOpportunity[];
  rejected: Array<{ productId: string; score: number; reasons: string[] }>;
  outcomes: AutonomousExecutionOutcome[];
};

const executionKey = (namespace: string, opportunity: ScoredOpportunity): string =>
  `${namespace}:${opportunity.product.id}:${opportunity.offerId ?? "no-offer"}`;

export class AutonomousExecutionService {
  constructor(
    private readonly selector: AutonomousOpportunitySelector,
    private readonly orchestrator: CampaignOrchestrator
  ) {}

  async runOnce(input: AutonomousExecutionInput): Promise<AutonomousExecutionResult> {
    const selection = this.selector.select(input.candidates, input.policy);
    const namespace = input.idempotencyNamespace?.trim() || "autonomous-execution";
    const candidatesByProduct = new Map(input.candidates.map((candidate) => [candidate.product.id, candidate]));
    const outcomes: AutonomousExecutionOutcome[] = [];

    for (const opportunity of selection.selected) {
      const candidate = candidatesByProduct.get(opportunity.product.id);
      const offer = candidate?.offers.find((item) => item.id === opportunity.offerId);
      const idempotencyKey = executionKey(namespace, opportunity);

      if (!offer) {
        outcomes.push({ productId: opportunity.product.id, offerId: opportunity.offerId, score: opportunity.score, status: "failed", idempotencyKey, error: "Selected opportunity has no matching affiliate offer." });
        continue;
      }

      try {
        const result = await this.orchestrator.execute({
          opportunity,
          offer,
          product: opportunity.product,
          audience: input.audience,
          platforms: input.platforms,
          scheduledAt: input.scheduledAt,
          idempotencyKey
        });
        outcomes.push({ productId: opportunity.product.id, offerId: offer.id, score: opportunity.score, status: "completed", idempotencyKey, result });
      } catch (error) {
        outcomes.push({ productId: opportunity.product.id, offerId: offer.id, score: opportunity.score, status: "failed", idempotencyKey, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return { selected: selection.selected, rejected: selection.rejected, outcomes };
  }
}

export type AutonomousExecutionCandidate = OpportunityCandidateSource & {
  product: Product;
  offers: AffiliateOffer[];
};
