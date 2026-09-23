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
};

export interface AutonomousActionOutcomeWriter {
  save(outcome: AutonomousActionOutcome): Promise<AutonomousActionOutcome>;
}

export class InMemoryAutonomousActionOutcomeRepository implements AutonomousActionOutcomeWriter {
  readonly outcomes: AutonomousActionOutcome[] = [];
  async save(outcome: AutonomousActionOutcome): Promise<AutonomousActionOutcome> {
    this.outcomes.push(outcome);
    return outcome;
  }
}
