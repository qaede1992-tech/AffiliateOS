import type { AutonomousDecisionAuditReader } from "./autonomous-decision-audit.js";
import type { OpportunityCandidateSource, OpportunitySelectionPoliciesByMarketplace, OpportunitySelectionPolicy } from "./autonomous-opportunity.js";

export type AdaptiveExplorationPolicy = {
  enabled?: boolean;
  minimumSamples?: number;
  minimumRate?: number;
  maximumRate?: number;
  promotionRateForReduction?: number;
  deprioritizationRateForIncrease?: number;
  reductionMultiplier?: number;
  increaseMultiplier?: number;
};

type ExplorationGroupSignal = {
  samples: number;
  promoted: number;
  deprioritized: number;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const groupKey = (marketplaceId: string, dimension: "category" | "audience", value: string): string =>
  `${marketplaceId}:${dimension}:${value.trim().toLowerCase()}`;

const add = (signals: Map<string, ExplorationGroupSignal>, key: string, status: string): void => {
  const current = signals.get(key) ?? { samples: 0, promoted: 0, deprioritized: 0 };
  current.samples += 1;
  if (status === "promote-to-exploitation") current.promoted += 1;
  if (status === "deprioritize") current.deprioritized += 1;
  signals.set(key, current);
};

export class AdaptiveExplorationPolicyProvider {
  constructor(private readonly reader: AutonomousDecisionAuditReader, private readonly policy: AdaptiveExplorationPolicy = {}) {}

  async getRates(
    candidates: OpportunityCandidateSource[],
    basePolicy: OpportunitySelectionPolicy,
    policiesByMarketplace: OpportunitySelectionPoliciesByMarketplace = {}
  ): Promise<Map<string, number>> {
    if (this.policy.enabled === false) return new Map();

    const minimumSamples = Math.max(1, this.policy.minimumSamples ?? 5);
    const promotionRateForReduction = clamp(this.policy.promotionRateForReduction ?? 0.6, 0, 1);
    const deprioritizationRateForIncrease = clamp(this.policy.deprioritizationRateForIncrease ?? 0.5, 0, 1);
    const minimumRate = clamp(this.policy.minimumRate ?? 0, 0, 1);
    const maximumRate = clamp(this.policy.maximumRate ?? 0.5, minimumRate, 1);
    const reductionMultiplier = Math.max(0, this.policy.reductionMultiplier ?? 0.5);
    const increaseMultiplier = Math.max(0, this.policy.increaseMultiplier ?? 1.5);

    const audits = await this.reader.list({ selected: true, limit: 500 });
    const signals = new Map<string, ExplorationGroupSignal>();
    const candidateByProduct = new Map(candidates.map((candidate) => [candidate.product.id, candidate]));

    for (const audit of audits) {
      const evaluation = audit.outcome?.explorationEvaluation;
      if (audit.selectionMode !== "exploration" || !evaluation) continue;
      const candidate = candidateByProduct.get(audit.productId);
      if (!candidate) continue;
      const category = candidate.product.category?.trim().toLowerCase();
      if (category) add(signals, groupKey(candidate.product.marketplaceId, "category", category), evaluation.status);
      const marketplacePolicy = { ...basePolicy, ...(policiesByMarketplace[candidate.product.marketplaceId] ?? {}) };
      for (const audience of marketplacePolicy.requiredAudience ?? []) {
        add(signals, groupKey(candidate.product.marketplaceId, "audience", String(audience)), evaluation.status);
      }
    }

    const rates = new Map<string, number>();
    for (const candidate of candidates) {
      const effective = { ...basePolicy, ...(policiesByMarketplace[candidate.product.marketplaceId] ?? {}) };
      const baseRate = clamp(effective.explorationRate ?? 0.2, minimumRate, maximumRate);
      let rate = baseRate;
      const category = candidate.product.category?.trim().toLowerCase();
      const categorySignal = category ? signals.get(groupKey(candidate.product.marketplaceId, "category", category)) : undefined;
      if (categorySignal && categorySignal.samples >= minimumSamples) {
        rate = this.adjust(rate, categorySignal, promotionRateForReduction, deprioritizationRateForIncrease, reductionMultiplier, increaseMultiplier, minimumRate, maximumRate);
      }
      for (const audience of effective.requiredAudience ?? []) {
        const audienceSignal = signals.get(groupKey(candidate.product.marketplaceId, "audience", String(audience)));
        if (audienceSignal && audienceSignal.samples >= minimumSamples) {
          rate = this.adjust(rate, audienceSignal, promotionRateForReduction, deprioritizationRateForIncrease, reductionMultiplier, increaseMultiplier, minimumRate, maximumRate);
        }
      }
      rates.set(candidate.product.id, rate);
    }
    return rates;
  }

  private adjust(
    rate: number,
    signal: ExplorationGroupSignal,
    promotionThreshold: number,
    deprioritizationThreshold: number,
    reductionMultiplier: number,
    increaseMultiplier: number,
    minimumRate: number,
    maximumRate: number
  ): number {
    const promotionRate = signal.promoted / signal.samples;
    const deprioritizationRate = signal.deprioritized / signal.samples;
    if (promotionRate >= promotionThreshold && deprioritizationRate < deprioritizationThreshold) {
      return clamp(rate * reductionMultiplier, minimumRate, maximumRate);
    }
    if (deprioritizationRate >= deprioritizationThreshold && promotionRate < promotionThreshold) {
      return clamp(rate * increaseMultiplier, minimumRate, maximumRate);
    }
    return rate;
  }
}
