import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresRepositories, DrizzleTransactionManager } from "./repositories.js";
import { ProviderEventStore } from "./provider-events.js";
import { DrizzleOptimizationStateReader } from "./autonomous-optimization-state.js";
import type { RepositorySet, TransactionManager } from "../domain/repository.js";

export interface DatabasePersistence {
  repositories: RepositorySet;
  transactionManager: TransactionManager;
  providerEvents: ProviderEventStore;
  optimizationState: DrizzleOptimizationStateReader;
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
    db,
    pool,
    close: () => pool.end()
  };
}
