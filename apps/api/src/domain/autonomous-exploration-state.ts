import type { AutonomousDecisionAudit } from "./autonomous-decision-audit.js";
export type AutonomousExplorationDimension="marketplace"|"category"|"audience";
export type AutonomousExplorationRegime = "rising" | "stable" | "declining" | "volatile";
export type AutonomousExplorationState={id:string;marketplaceId:string;dimension:AutonomousExplorationDimension;dimensionKey:string;sampleCount:number;promotedCount:number;deprioritizedCount:number;optimizationPositiveCount:number;optimizationNegativeCount:number;regimeRisingCount:number;regimeStableCount:number;regimeDecliningCount:number;regimeVolatileCount:number;observedAt:string;};
export interface AutonomousExplorationStateRepository{applyEvaluatedAudits(audits:AutonomousDecisionAudit[]):Promise<void>;listByMarketplaces(marketplaceIds:string[]):Promise<AutonomousExplorationState[]>;
  applyOptimizationFeedback(): Promise<void>;}