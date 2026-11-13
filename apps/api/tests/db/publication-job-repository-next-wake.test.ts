import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { DrizzlePublicationJobRepository } from "../../src/db/publication-job-repository.js";

test("nextWakeAt returns one aggregate timestamp for active jobs only", async () => {
  let selection: Record<string, unknown> | undefined;
  let whereExpression: unknown;
  const db = {
    select(values: Record<string, unknown>) {
      selection = values;
      return {
        from() {
          return {
            innerJoin() {
              return {
                where(expression: unknown) {
                  whereExpression = expression;
                  return Promise.resolve([{ nextAt: "2026-09-21T10:05:00.000Z" }]);
                }
              };
            }
          };
        }
      };
    }
  };

  const repository = new DrizzlePublicationJobRepository(db as never);
  assert.equal((await repository.nextWakeAt(10 * 60 * 1000))?.toISOString(), "2026-09-21T10:05:00.000Z");

  const aggregate = new PgDialect().sqlToQuery(selection?.nextAt as never);
  assert.match(aggregate.sql, /min\(/i);
  assert.match(aggregate.sql, /CASE/i);
  assert.match(aggregate.sql, /GREATEST/i);
  assert.match(aggregate.sql, /content/);

  const filter = new PgDialect().sqlToQuery(whereExpression as never);
  assert.deepEqual(filter.params, ["pending", "failed", "processing"]);
});

test("nextWakeAt returns undefined when no active job can wake the worker", async () => {
  const db = {
    select() {
      return {
        from() {
          return {
            innerJoin() {
              return {
                where() {
                  return Promise.resolve([{ nextAt: null }]);
                }
              };
            }
          };
        }
      };
    }
  };
  const repository = new DrizzlePublicationJobRepository(db as never);
  assert.equal(await repository.nextWakeAt(10 * 60 * 1000), undefined);
});
