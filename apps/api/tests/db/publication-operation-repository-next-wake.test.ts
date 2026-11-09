import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { DrizzlePublicationOperationRepository } from "../../src/db/publication-operation-repository.js";

test("findEarliestReconciliationUpdatedAt returns one timestamp from active operations", async () => {
  let whereExpression: unknown;
  let limitValue: number | undefined;
  const db = {
    select() {
      return {
        from() {
          return {
            where(expression: unknown) {
              whereExpression = expression;
              return {
                orderBy() {
                  return {
                    limit(value: number) {
                      limitValue = value;
                      return Promise.resolve([{ updatedAt: "2026-09-21T10:00:00.000Z" }]);
                    }
                  };
                }
              };
            }
          };
        }
      };
    }
  };

  const repository = new DrizzlePublicationOperationRepository(db as never);
  assert.equal(await repository.findEarliestReconciliationUpdatedAt(), "2026-09-21T10:00:00.000Z");
  assert.equal(limitValue, 1);
  const filter = new PgDialect().sqlToQuery(whereExpression as never);
  assert.deepEqual(filter.params, ["accepted", "processing"]);
});

test("findEarliestReconciliationUpdatedAt returns undefined when no operation is active", async () => {
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    limit() {
                      return Promise.resolve([]);
                    }
                  };
                }
              };
            }
          };
        }
      };
    }
  };
  const repository = new DrizzlePublicationOperationRepository(db as never);
  assert.equal(await repository.findEarliestReconciliationUpdatedAt(), undefined);
});
