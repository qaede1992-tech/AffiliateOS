import { and, eq } from "drizzle-orm";
import type { EntityId } from "@affiliateos/shared";
import type { AutonomousOptimizationStateRepository } from "../domain/autonomous-optimization-state.js";
import type { OptimizationState } from "../domain/optimization-engine.js";
import { autonomousOptimizationStates } from "./schema.js";

type DatabaseExecutor = any;
type StateRow = typeof autonomousOptimizationStates.$inferSelect;

const toDomain = (row: StateRow): OptimizationState => ({
  action: row.action as OptimizationState["action"],
  appliedAt: row.appliedAt
});

export class DrizzleAutonomousOptimizationStateRepository implements AutonomousOptimizationStateRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async get(campaignId: EntityId): Promise<OptimizationState | undefined> {
    const rows = await this.db.select().from(autonomousOptimizationStates)
      .where(eq(autonomousOptimizationStates.campaignId, campaignId))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async compareAndSet(campaignId: EntityId, expectedAppliedAt: string | undefined, state: OptimizationState): Promise<boolean> {
    if (expectedAppliedAt === undefined) {
      const now = new Date().toISOString();
      const rows = await this.db.insert(autonomousOptimizationStates).values({ campaignId, action: state.action, appliedAt: state.appliedAt, createdAt: now, updatedAt: now }).onConflictDoNothing({ target: autonomousOptimizationStates.campaignId }).returning({ campaignId: autonomousOptimizationStates.campaignId });
      return rows.length > 0;
    }
    const rows = await this.db.update(autonomousOptimizationStates)
      .set({ action: state.action, appliedAt: state.appliedAt, updatedAt: new Date().toISOString() })
      .where(and(eq(autonomousOptimizationStates.campaignId, campaignId), eq(autonomousOptimizationStates.appliedAt, expectedAppliedAt)))
      .returning({ campaignId: autonomousOptimizationStates.campaignId });
    return rows.length > 0;
  }

  async save(campaignId: EntityId, state: OptimizationState): Promise<OptimizationState> {
    const existing = await this.get(campaignId);
    const now = new Date().toISOString();
    if (existing) {
      await this.db.update(autonomousOptimizationStates)
        .set({ action: state.action, appliedAt: state.appliedAt, updatedAt: now })
        .where(eq(autonomousOptimizationStates.campaignId, campaignId));
    } else {
      await this.db.insert(autonomousOptimizationStates).values({
        campaignId,
        action: state.action,
        appliedAt: state.appliedAt,
        createdAt: now,
        updatedAt: now
      });
    }
    return state;
  }
}
