import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { DrizzleProductMediaDiscoveryAttemptRepository } from "../../src/db/product-media-discovery-attempt-repository.js";

test("discovery completion is fenced to the exact active lease", async () => {
  let updateValues: Record<string, unknown> | undefined;
  let whereExpression: unknown;
  const db = {
    update() {
      return {
        set(values: Record<string, unknown>) {
          updateValues = values;
          return {
            where(expression: unknown) {
              whereExpression = expression;
              return Promise.resolve();
            }
          };
        }
      };
    }
  };

  const repository = new DrizzleProductMediaDiscoveryAttemptRepository(db as never);
  const leaseUntil = "2026-11-09T04:00:00.000Z";
  await repository.complete({
    productId: "00000000-0000-4000-8000-000000000001",
    fingerprint: "a".repeat(64),
    leaseUntil,
    outcome: "success",
    now: "2026-11-09T03:45:00.000Z",
    nextRetryAt: "2026-11-16T03:45:00.000Z"
  });

  assert.equal(updateValues?.status, "success");
  assert.equal(updateValues?.nextRetryAt, "2026-11-16T03:45:00.000Z");
  assert.ok(whereExpression);
  const query = new PgDialect().sqlToQuery(whereExpression as never);
  assert.match(query.sql, /"status" = \$\d+/);
  assert.match(query.sql, /"next_retry_at" = \$\d+/);
  assert.ok(query.params.includes("in_progress"));
  assert.ok(query.params.includes(leaseUntil));
});
