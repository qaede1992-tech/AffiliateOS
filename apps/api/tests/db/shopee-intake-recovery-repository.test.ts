import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { DrizzleShopeeAffiliateLinkIntakeRepository } from "../../src/db/repositories.js";

test("nextStaleResolvingAt uses one aggregate timestamp for resolving intakes", async () => {
  let selection: Record<string, unknown> | undefined;
  let whereExpression: unknown;
  const db = {
    select(values: Record<string, unknown>) {
      selection = values;
      return {
        from() {
          return {
            where(expression: unknown) {
              whereExpression = expression;
              return Promise.resolve([{ nextAt: new Date("2026-11-13T10:05:00.000Z") }]);
            }
          };
        }
      };
    }
  };

  const repository = new DrizzleShopeeAffiliateLinkIntakeRepository(db as never);
  assert.equal(await repository.nextStaleResolvingAt(), "2026-11-13T10:05:00.000Z");

  const aggregate = new PgDialect().sqlToQuery(selection?.nextAt as never);
  assert.match(aggregate.sql, /min\(/i);
  assert.match(aggregate.sql, /interval '5 minutes'/i);

  const filter = new PgDialect().sqlToQuery(whereExpression as never);
  assert.deepEqual(filter.params, ["resolving"]);
});

test("nextStaleResolvingAt returns undefined when no intake is resolving", async () => {
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve([{ nextAt: null }]);
            }
          };
        }
      };
    }
  };
  const repository = new DrizzleShopeeAffiliateLinkIntakeRepository(db as never);
  assert.equal(await repository.nextStaleResolvingAt(), undefined);
});
