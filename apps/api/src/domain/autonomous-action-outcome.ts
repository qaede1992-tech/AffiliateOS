import type { OptimizationAction } from "./optimization-engine.js";

export type AutonomousActionOutcomeStatus = "mutated" | "skipped" | "failed";

export type AutonomousActionOutcome = {
  id: string;
  campaignId: string;
  action: OptimizationAction;
  status: AutonomousActionOutcomeStatus;
  mutated: boolean;
  observedAt: string;
  error?: string;
  baseline?: AutonomousActionMetrics;
  observed?: AutonomousActionMetrics;
  evaluation?: AutonomousActionMetrics;
  evaluatedAt?: string;
  recoveryState?: "none" | "recovering" | "recovered";
  recoveryEvidenceScore?: number;
  recoveryEpisodeId?: string;
  recoveryPolicy?: { explorationFloor: number; direction: "hold-exploration" | "reduce-exploration" | "neutral"; qualityDelta?: number };
};

export type AutonomousActionMetrics = {
  clickCount: number;
  attributedConversionCount: number;
  attributedRevenueCents: number;
  attributedCommissionCents: number;
  conversionRate: number;
};

export interface AutonomousActionOutcomeWriter {
  save(outcome: AutonomousActionOutcome): Promise<AutonomousActionOutcome>;
  updateMetrics?(id: string, metrics: { baseline?: AutonomousActionMetrics; observed?: AutonomousActionMetrics }): Promise<AutonomousActionOutcome | undefined>;
  latestByCampaign?(campaignId: string): Promise<AutonomousActionOutcome | undefined>;
  updateEvaluation?(id: string, evaluation: AutonomousActionMetrics, evaluatedAt: string): Promise<AutonomousActionOutcome | undefined>;
  updateRecovery?(id: string, recovery: { state: "none" | "recovering" | "recovered"; evidenceScore?: number; episodeId?: string; policy?: AutonomousActionOutcome["recoveryPolicy"] }): Promise<AutonomousActionOutcome | undefined>;
}

export class InMemoryAutonomousActionOutcomeRepository implements AutonomousActionOutcomeWriter {
  readonly outcomes: AutonomousActionOutcome[] = [];
  async save(outcome: AutonomousActionOutcome): Promise<AutonomousActionOutcome> {
    this.outcomes.push(outcome);
    return outcome;
  }
  async updateMetrics(id: string, metrics: { baseline?: AutonomousActionMetrics; observed?: AutonomousActionMetrics }) {
    const item = this.outcomes.find((outcome) => outcome.id === id);
    if (!item) return undefined;
    Object.assign(item, metrics);
    return item;
  }
  async latestByCampaign(campaignId: string) {
    return [...this.outcomes].filter((outcome) => outcome.campaignId === campaignId).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  }
  async updateEvaluation(id: string, evaluation: AutonomousActionMetrics, evaluatedAt: string) {
    const item = this.outcomes.find((outcome) => outcome.id === id);
    if (!item) return undefined;
    item.evaluation = evaluation;
    item.evaluatedAt = evaluatedAt;
    return item;
  }
  async updateRecovery(id: string, recovery: { state: "none" | "recovering" | "recovered"; evidenceScore?: number; episodeId?: string; policy?: AutonomousActionOutcome["recoveryPolicy"] }) {
    const item = this.outcomes.find((outcome) => outcome.id === id);
    if (!item) return undefined;
    item.recoveryState = recovery.state;
    item.recoveryEvidenceScore = recovery.evidenceScore ?? 0;
    item.recoveryEpisodeId = recovery.episodeId;
    item.recoveryPolicy = recovery.policy;
    return item;
  }
}
