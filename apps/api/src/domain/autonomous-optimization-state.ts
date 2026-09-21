import type { EntityId } from "@affiliateos/shared";
import type { OptimizationState } from "./optimization-engine.js";

export interface AutonomousOptimizationStateRepository {
  get(campaignId: EntityId): Promise<OptimizationState | undefined>;
  save(campaignId: EntityId, state: OptimizationState): Promise<OptimizationState>;
  compareAndSet?(campaignId: EntityId, expectedAppliedAt: string | undefined, state: OptimizationState): Promise<boolean>;
}

export class InMemoryAutonomousOptimizationStateRepository implements AutonomousOptimizationStateRepository {
  private readonly states = new Map<EntityId, OptimizationState>();
  async get(campaignId: EntityId) { return this.states.get(campaignId); }
  async save(campaignId: EntityId, state: OptimizationState) { this.states.set(campaignId, state); return state; }
  async compareAndSet(campaignId: EntityId, expectedAppliedAt: string | undefined, state: OptimizationState) {
    const current = this.states.get(campaignId);
    if ((current?.appliedAt ?? undefined) !== expectedAppliedAt) return false;
    this.states.set(campaignId, state);
    return true;
  }
}
