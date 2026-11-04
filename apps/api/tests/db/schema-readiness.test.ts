import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { assertMediaSchemaReady } from "../../src/db/schema-readiness.js";

const completeSchema = {
  hasPreMediaEligibilityEvidence: true,
  hasPreMediaEligibilityColumns: true,
  hasProductMediaCandidateReviewAudits: true,
  hasProductMediaCandidateReviewAuditColumns: true,
  hasProductMediaProvenanceColumns: true,
  hasProductMediaCandidateReviewColumns: true
};

const executorFor = (rows: unknown[]) => ({
  execute: async (_query: Parameters<Parameters<typeof assertMediaSchemaReady>[0]["execute"]>[0]) => ({ rows })
});

test("accepts a database with the complete product media schema", async () => {
  let statement = "";
  const db = {
    execute: async (query: Parameters<Parameters<typeof assertMediaSchemaReady>[0]["execute"]>[0]) => {
      statement = new PgDialect().sqlToQuery(query).sql;
      return { rows: [completeSchema] };
    }
  };

  await assertMediaSchemaReady(db);

  assert.match(statement, /pre_media_eligibility_evidence/);
  assert.match(statement, /cycle_id/);
  assert.match(statement, /product_media_candidate_review_audits/);
  assert.match(statement, /actor_role/);
  assert.match(statement, /source_provider/);
  assert.match(statement, /reviewed_by/);
  assert.match(statement, /reviewed_at/);
  assert.match(statement, /review_reason/);
});

test("rejects each missing product media schema dependency", async () => {
  for (const key of Object.keys(completeSchema) as (keyof typeof completeSchema)[]) {
    const row = { ...completeSchema, [key]: false };
    await assert.rejects(
      () => assertMediaSchemaReady(executorFor([row])),
      /Required product media schema is incomplete/
    );
  }
});

test("rejects when the schema readiness query returns no row", async () => {
  await assert.rejects(
    () => assertMediaSchemaReady(executorFor([])),
    /Required product media schema is incomplete/
  );
});

test("propagates database query failures", async () => {
  const db = {
    execute: async () => {
      throw new Error("database unavailable");
    }
  };

  await assert.rejects(() => assertMediaSchemaReady(db), /database unavailable/);
});
