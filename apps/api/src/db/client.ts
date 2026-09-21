import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresRepositories, DrizzleTransactionManager } from "./repositories.js";
import { ProviderEventStore } from "./provider-events.js";
import type { RepositorySet, TransactionManager } from "../domain/repository.js";

export interface DatabasePersistence {
  repositories: RepositorySet;
  transactionManager: TransactionManager;
  providerEvents: ProviderEventStore;
  db: ReturnType<typeof drizzle>;
  close(): Promise<void>;
}

export function createDatabasePersistence(connectionString: string): DatabasePersistence {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  return {
    repositories: createPostgresRepositories(db),
    transactionManager: new DrizzleTransactionManager(db),
    providerEvents: new ProviderEventStore(db),
    db,
    close: () => pool.end()
  };
}
