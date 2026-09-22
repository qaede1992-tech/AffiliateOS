import { desc, eq } from "drizzle-orm";
import type { OptimizationState, OptimizationAction } from "../domain/optimization-engine.js";
import type { OptimizationStateReader } from "../domain/autonomous-optimization.js";
import { pgTable, timestamp, uuid, varchar, uniqueIndex } from "drizzle-orm/pg-core";

export const autonomousOptimizationStates = pgTable("autonomous_optimization_states", {
  campaignId: uuid("campaign_id").primaryKey(),
  action: varchar("action", { length: 20 }).notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [uniqueIndex("autonomous_optimization_states_campaign_unique").on(table.campaignId)]);

type DatabaseExecutor = any;
type StateRow = typeof autonomousOptimizationStates.$inferSelect;
const actions = new Set<OptimizationAction>(["scale", "maintain", "revise-content", "pause"]);

const toDomain = (row: StateRow): OptimizationState => {
  if (!actions.has(row.action as OptimizationAction)) throw new Error(`Unknown optimization action persisted for campaign ${row.campaignId}.`);
  return { action: row.action as OptimizationAction, appliedAt: row.appliedAt };
};

export class DrizzleOptimizationStateReader implements OptimizationStateReader {
  constructor(private readonly db: DatabaseExecutor) {}

  async get(campaignId: string): Promise<OptimizationState | undefined> {
    const rows = await this.db.select().from(autonomousOptimizationStates).where(eq(autonomousOptimizationStates.campaignId, campaignId)).orderBy(desc(autonomousOptimizationStates.updatedAt)).limit(1);
    return rows[0] ? toDomain(rows[0]) : undefined;
  }

  async save(campaignId: string, state: OptimizationState): Promise<OptimizationState> {
    if (!actions.has(state.action)) throw new Error(`Unsupported optimization action: ${state.action}`);
    const now = new Date().toISOString();
    const rows = await this.db.insert(autonomousOptimizationStates).values({ campaignId, action: state.action, appliedAt: state.appliedAt, createdAt: now, updatedAt: now }).onConflictDoUpdate({ target: autonomousOptimizationStates.campaignId, set: { action: state.action, appliedAt: state.appliedAt, updatedAt: now } }).returning();
    return toDomain(rows[0]);
  }
}
