import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresRepositories, DrizzleTransactionManager } from "../../src/db/repositories.js";

test("Drizzle marketplace-import transaction rolls back earlier writes when a later row fails", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  const repositories = createPostgresRepositories(db);
  const transactions = new DrizzleTransactionManager(db);
  const firstId = randomUUID();
  const secondId = randomUUID();
  const timestamp = new Date().toISOString();

  try {
    await assert.rejects(
      transactions.runMarketplaceImport(async (transactionRepositories) => {
        await transactionRepositories.affiliates.save({
          id: firstId,
          name: "Rollback probe first row",
          email: `rollback-first-${firstId}@example.invalid`,
          status: "active",
          createdAt: timestamp,
        });
        await transactionRepositories.affiliates.save({
          id: secondId,
          name: "Rollback probe second row",
          email: `rollback-second-${secondId}@example.invalid`,
          status: "active",
          createdAt: timestamp,
        });
        throw new Error("injected failure after second row");
      }),
      /injected failure after second row/,
    );

    assert.equal(await repositories.affiliates.findById(firstId), undefined);
    assert.equal(await repositories.affiliates.findById(secondId), undefined);
  } finally {
    await pool.end();
  }
});
