import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { autonomousExplorationOptimizationEvents, autonomousExplorationStateEvents, autonomousExplorationStates } from "./schema.js";
import type { AutonomousDecisionAudit } from "../domain/autonomous-decision-audit.js";
import type { AutonomousExplorationDimension, AutonomousExplorationState, AutonomousExplorationStateRepository } from "../domain/autonomous-exploration-state.js";
type DatabaseExecutor=any;
const normalize=(value:string)=>value.trim().toLowerCase();
const dimensionsFor=(audit:AutonomousDecisionAudit):Array<{dimension:AutonomousExplorationDimension;key:string}>=>[
 {dimension:"marketplace",key:audit.marketplaceId},
 ...(audit.category?.trim()?[{dimension:"category" as const,key:normalize(audit.category)}]:[]),
 ...(audit.audienceSegments??[]).filter(v=>String(v).trim()).map(v=>({dimension:"audience" as const,key:normalize(String(v))}))
];
export class DrizzleAutonomousExplorationStateRepository implements AutonomousExplorationStateRepository{
 constructor(private readonly db:DatabaseExecutor){}
 async applyEvaluatedAudits(audits:AutonomousDecisionAudit[]){const evaluated=audits.filter(a=>a.selected&&a.selectionMode==="exploration"&&(a.outcome?.explorationEvaluation?.status==="promote-to-exploitation"||a.outcome?.explorationEvaluation?.status==="deprioritize"));if(!evaluated.length)return;await this.db.transaction(async(tx:DatabaseExecutor)=>{for(const audit of evaluated){const status=audit.outcome!.explorationEvaluation!.status;for(const {dimension,key} of dimensionsFor(audit)){await tx.insert(autonomousExplorationStates).values({id:randomUUID(),marketplaceId:audit.marketplaceId,dimension,dimensionKey:key,observedAt:audit.createdAt,createdAt:audit.createdAt,updatedAt:audit.createdAt}).onConflictDoNothing({target:[autonomousExplorationStates.marketplaceId,autonomousExplorationStates.dimension,autonomousExplorationStates.dimensionKey]});const [state]=await tx.select({id:autonomousExplorationStates.id}).from(autonomousExplorationStates).where(and(eq(autonomousExplorationStates.marketplaceId,audit.marketplaceId),eq(autonomousExplorationStates.dimension,dimension),eq(autonomousExplorationStates.dimensionKey,key))).limit(1);if(!state)continue;const inserted=await tx.insert(autonomousExplorationStateEvents).values({id:randomUUID(),stateId:state.id,auditId:audit.auditId,status,createdAt:audit.createdAt}).onConflictDoNothing({target:[autonomousExplorationStateEvents.stateId,autonomousExplorationStateEvents.auditId]}).returning({id:autonomousExplorationStateEvents.id});if(!inserted.length)continue;await tx.update(autonomousExplorationStates).set({sampleCount:sql`${autonomousExplorationStates.sampleCount}+1`,promotedCount:status==="promote-to-exploitation"?sql`${autonomousExplorationStates.promotedCount}+1`:autonomousExplorationStates.promotedCount,deprioritizedCount:status==="deprioritize"?sql`${autonomousExplorationStates.deprioritizedCount}+1`:autonomousExplorationStates.deprioritizedCount,observedAt:audit.createdAt,updatedAt:audit.createdAt}).where(eq(autonomousExplorationStates.id,state.id));}}});}
 async applyOptimizationFeedback(): Promise<void> {
  const rows = await this.db.execute(sql`SELECT o.id AS outcome_id, o.action, o.observed_at, o.baseline_metrics, o.evaluation_metrics,
    c.audience ->> 'marketplaceId' AS marketplace_id,
    c.audience ->> 'productId' AS product_id,
    c.audience -> 'audience' AS audience_segments,
    p.category AS category
    FROM autonomous_action_outcomes o
    JOIN campaigns c ON c.id = o.campaign_id
    LEFT JOIN products p ON p.id = NULLIF(c.audience ->> 'productId', '')::uuid
    WHERE o.status = 'mutated' AND o.evaluated_at IS NOT NULL AND o.evaluation_metrics IS NOT NULL
      AND COALESCE(o.recovery_state, 'none') <> 'recovering'`);
  if (!rows.rows?.length) return;
  await this.db.transaction(async (tx: DatabaseExecutor) => {
    for (const row of rows.rows as any[]) {
      const baseline = row.baseline_metrics ?? {};
      const evaluation = row.evaluation_metrics ?? {};
      const conversionDelta = Number(evaluation.conversionRate ?? 0) - Number(baseline.conversionRate ?? 0);
      const baselineClicks = Number(baseline.clickCount ?? 0);
      const evalClicks = Number(evaluation.clickCount ?? 0);
      const baselineCpc = baselineClicks > 0 ? Number(baseline.attributedCommissionCents ?? 0) / baselineClicks : 0;
      const evalCpc = evalClicks > 0 ? Number(evaluation.attributedCommissionCents ?? 0) / evalClicks : 0;
      const signal = row.action === "pause" || (conversionDelta < 0 && evalCpc < baselineCpc) ? "negative"
        : row.action === "scale" && conversionDelta > 0 && evalCpc >= baselineCpc ? "positive" : null;
      if (!signal || !row.marketplace_id) continue;
      const dimensions = [
        { dimension: "marketplace" as const, key: normalize(String(row.marketplace_id)) },
        ...(row.category ? [{ dimension: "category" as const, key: normalize(String(row.category)) }] : []),
        ...((Array.isArray(row.audience_segments) ? row.audience_segments : []).filter((v: unknown) => String(v).trim()).map((v: unknown) => ({ dimension: "audience" as const, key: normalize(String(v)) })))
      ];
      for (const { dimension, key } of dimensions) {
        await tx.insert(autonomousExplorationStates).values({ id: randomUUID(), marketplaceId: row.marketplace_id, dimension, dimensionKey: key, observedAt: row.observed_at, createdAt: row.observed_at, updatedAt: row.observed_at }).onConflictDoNothing({ target: [autonomousExplorationStates.marketplaceId, autonomousExplorationStates.dimension, autonomousExplorationStates.dimensionKey] });
        const [state] = await tx.select({ id: autonomousExplorationStates.id }).from(autonomousExplorationStates).where(and(eq(autonomousExplorationStates.marketplaceId, row.marketplace_id), eq(autonomousExplorationStates.dimension, dimension), eq(autonomousExplorationStates.dimensionKey, key))).limit(1);
        if (!state) continue;
        const inserted = await tx.insert(autonomousExplorationOptimizationEvents).values({ id: randomUUID(), stateId: state.id, actionOutcomeId: row.outcome_id, signal, createdAt: row.observed_at }).onConflictDoNothing({ target: [autonomousExplorationOptimizationEvents.stateId, autonomousExplorationOptimizationEvents.actionOutcomeId] }).returning({ id: autonomousExplorationOptimizationEvents.id });
        if (!inserted.length) continue;
        await tx.update(autonomousExplorationStates).set({
          optimizationPositiveCount: signal === "positive" ? sql`${autonomousExplorationStates.optimizationPositiveCount} + 1` : autonomousExplorationStates.optimizationPositiveCount,
          optimizationNegativeCount: signal === "negative" ? sql`${autonomousExplorationStates.optimizationNegativeCount} + 1` : autonomousExplorationStates.optimizationNegativeCount,
          observedAt: row.observed_at,
          updatedAt: row.observed_at
        }).where(eq(autonomousExplorationStates.id, state.id));
      }
    }
  });
}
async listByMarketplaces(marketplaceIds:string[]):Promise<AutonomousExplorationState[]>{if(!marketplaceIds.length)return[];const rows=await this.db.select().from(autonomousExplorationStates).where(inArray(autonomousExplorationStates.marketplaceId,marketplaceIds));return rows.map((r:any)=>({id:r.id,marketplaceId:r.marketplaceId,dimension:r.dimension as AutonomousExplorationDimension,dimensionKey:r.dimensionKey,sampleCount:r.sampleCount,promotedCount:r.promotedCount,deprioritizedCount:r.deprioritizedCount,optimizationPositiveCount:r.optimizationPositiveCount,optimizationNegativeCount:r.optimizationNegativeCount,observedAt:r.observedAt}));}
}