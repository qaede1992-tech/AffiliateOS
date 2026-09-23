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
}
