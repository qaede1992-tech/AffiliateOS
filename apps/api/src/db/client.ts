import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresRepositories, DrizzleTransactionManager } from "./repositories.js";
import type { RepositorySet, TransactionManager } from "../domain/repository.js";

export interface DatabasePersistence {
  repositories: RepositorySet;
  transactionManager: TransactionManager;
  close(): Promise<void>;
}

export function createDatabasePersistence(connectionString: string): DatabasePersistence {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  return {
    repositories: createPostgresRepositories(db),
    transactionManager: new DrizzleTransactionManager(db),
    close: () => pool.end()
  };
}