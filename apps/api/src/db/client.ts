import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresRepositories, DrizzleTransactionManager } from "./repositories.js";
import { ProviderEventStore } from "./provider-events.js";
import { DrizzleOptimizationStateReader } from "./autonomous-optimization-state.js";
import { DrizzleAutonomousDecisionAuditRepository } from "./autonomous-decision-audit-repository.js";
import { DrizzleAutonomousActionOutcomeRepository } from "./autonomous-action-outcome-repository.js";
import { DrizzleAutonomousExplorationStateRepository } from "./autonomous-exploration-state-repository.js";
import type { RepositorySet, TransactionManager } from "../domain/repository.js";

export interface DatabasePersistence {
  repositories: RepositorySet;
  transactionManager: TransactionManager;
  providerEvents: ProviderEventStore;
  optimizationState: DrizzleOptimizationStateReader;
  autonomousDecisionAudits: DrizzleAutonomousDecisionAuditRepository;
  autonomousActionOutcomes: DrizzleAutonomousActionOutcomeRepository;
  autonomousExplorationStates: DrizzleAutonomousExplorationStateRepository;
  db: ReturnType<typeof drizzle>;
  pool: Pool;
  close(): Promise<void>;
}

export function createDatabasePersistence(connectionString: string): DatabasePersistence {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  return {
    repositories: createPostgresRepositories(db),
    transactionManager: new DrizzleTransactionManager(db),
    providerEvents: new ProviderEventStore(db),
    optimizationState: new DrizzleOptimizationStateReader(db),
    autonomousDecisionAudits: new DrizzleAutonomousDecisionAuditRepository(db),
    autonomousActionOutcomes: new DrizzleAutonomousActionOutcomeRepository(db),
    autonomousExplorationStates: new DrizzleAutonomousExplorationStateRepository(db),
    db,
    pool,
    close: () => pool.end()
  };
}
