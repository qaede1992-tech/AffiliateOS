import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { ProductMediaCandidateRecord } from "../../src/domain/product-media-candidate.js";
import { DrizzleProductMediaCandidateRepository } from "../../src/db/product-media-candidate-repository.js";
import { productMediaCandidates } from "../../src/db/schema.js";

const candidate: ProductMediaCandidateRecord = {
  id: "462d1fd3-46d4-4832-a812-0b538ebd8144",
  productId: "7f1c4c8d-7a2f-4e61-8b0d-1dcb3b48c001",
  provider: "wikimedia_commons",
  candidateHash: "a".repeat(64),
  query: "wireless headphones",
  title: "Wireless headphones product image",
  imageUrl: "https://upload.wikimedia.org/example.jpg",
  landingPageUrl: "https://commons.wikimedia.org/wiki/File:Example.jpg",
  creator: "Photographer",
  creatorUrl: "https://commons.wikimedia.org/wiki/User:Photographer",
  license: "cc-by",
  licenseVersion: "4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  sourcePublisher: "Wikimedia Commons",
  identityScore: 70,
  identityStatus: "review_required",
  identityReasons: ["category-level match"],
  reviewStatus: "pending",
  rightsStatus: "unverified",
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z"
};

test("refreshes duplicate discovery evidence only while review and rights remain pending", async () => {
  let conflictConfig: Record<string, any> | undefined;
  let insertedValues: Array<Record<string, unknown>> = [];

  const db = {
    insert(table: unknown) {
      assert.equal(table, productMediaCandidates);
      return {
        values(values: Array<Record<string, unknown>>) {
          insertedValues = values;
          return {
            onConflictDoUpdate(config: Record<string, any>) {
              conflictConfig = config;
              return {
                returning: async () => [candidate]
              };
            }
          };
        }
      };
    }
  };

  const repository = new DrizzleProductMediaCandidateRepository(db as never);
  const saved = await repository.saveMany([candidate]);

  assert.equal(saved.length, 1);
  assert.deepEqual(insertedValues[0]?.reviewStatus, "pending");
  assert.deepEqual(insertedValues[0]?.rightsStatus, "unverified");
  assert.ok(conflictConfig?.setWhere);

  const refreshGuard = new PgDialect().sqlToQuery(conflictConfig.setWhere);
  assert.match(refreshGuard.sql, /review_status/);
  assert.match(refreshGuard.sql, /rights_status/);
  assert.deepEqual(refreshGuard.params, ["pending", "unverified"]);

  assert.equal(conflictConfig.set.reviewStatus, undefined);
  assert.equal(conflictConfig.set.rightsStatus, undefined);
  assert.ok(conflictConfig.set.license);
  assert.ok(conflictConfig.set.identityStatus);
});

test("does not issue a database write for an empty candidate batch", async () => {
  let insertCalls = 0;
  const db = {
    insert() {
      insertCalls += 1;
      throw new Error("empty candidate batches must not write");
    }
  };
  const repository = new DrizzleProductMediaCandidateRepository(db as never);

  assert.deepEqual(await repository.saveMany([]), []);
  assert.equal(insertCalls, 0);
});
