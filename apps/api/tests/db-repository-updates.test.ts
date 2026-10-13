import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresRepositories } from "../src/db/repositories.js";
import { commissions, conversions } from "../src/db/schema.js";

test("updates existing conversions and commissions instead of reinserting during provider reconciliation", async () => {
  const conversionRow = {
    id: "00000000-0000-4000-8000-000000000101",
    affiliateOfferId: null,
    affiliateId: "00000000-0000-4000-8000-000000000102",
    offerId: "00000000-0000-4000-8000-000000000103",
    amountCents: 1000,
    status: "pending",
    occurredAt: "2026-10-13T00:00:00.000Z",
    idempotencyKey: "provider:account-a:conversion-a"
  };
  const commissionRow = {
    id: "00000000-0000-4000-8000-000000000104",
    conversionId: conversionRow.id,
    affiliateId: conversionRow.affiliateId,
    amountCents: 100,
    status: "pending",
    createdAt: "2026-10-13T00:00:00.000Z"
  };
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const inserts: unknown[] = [];
  const db = {
    select() {
      let selectedTable: unknown;
      return {
        from(table: unknown) {
          selectedTable = table;
          return {
            where() {
              return {
                limit: async () => selectedTable === conversions
                  ? [conversionRow]
                  : selectedTable === commissions
                    ? [commissionRow]
                    : []
              };
            }
          };
        }
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where: async () => { updates.push({ table, values }); }
          };
        }
      };
    },
    insert(table: unknown) {
      return {
        values: async () => { inserts.push(table); }
      };
    }
  };

  const repositories = createPostgresRepositories(db as never);
  await repositories.conversions.save({
    id: conversionRow.id,
    affiliateId: conversionRow.affiliateId,
    offerId: conversionRow.offerId,
    amountCents: conversionRow.amountCents,
    status: "approved",
    occurredAt: conversionRow.occurredAt,
    idempotencyKey: conversionRow.idempotencyKey
  });
  await repositories.commissions.save({
    id: commissionRow.id,
    conversionId: commissionRow.conversionId,
    affiliateId: commissionRow.affiliateId,
    amountCents: 125,
    status: "approved",
    createdAt: commissionRow.createdAt
  });

  assert.deepEqual(updates.map((entry) => entry.table), [conversions, commissions]);
  assert.equal(updates[0]?.values.status, "approved");
  assert.equal(updates[1]?.values.status, "approved");
  assert.equal(updates[1]?.values.amountCents, 125);
  assert.equal(inserts.length, 0);
});
