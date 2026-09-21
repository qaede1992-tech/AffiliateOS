import type { EntityId } from "@affiliateos/shared";
import type { OptimizationState } from "./optimization-engine.js";

export interface AutonomousOptimizationStateRepository {
  get(campaignId: EntityId): Promise<OptimizationState | undefined>;
  save(campaignId: EntityId, state: OptimizationState): Promise<OptimizationState>;
}

export class InMemoryAutonomousOptimizationStateRepository implements AutonomousOptimizationStateRepository {
  private readonly states = new Map<EntityId, OptimizationState>();
  async get(campaignId: EntityId) { return this.states.get(campaignId); }
  async save(campaignId: EntityId, state: OptimizationState) { this.states.set(campaignId, state); return state; }
}
