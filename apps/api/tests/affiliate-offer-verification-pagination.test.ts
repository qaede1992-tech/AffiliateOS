import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { createPostgresRepositories } from "../src/db/repositories.js";
import { affiliateAccounts, affiliateOffers, affiliates, marketplaces, products } from "../src/db/schema.js";

const offerRow = {
  id: "00000000-0000-4000-8000-000000000101",
  productId: "00000000-0000-4000-8000-000000000102",
  conversionOfferId: null,
  affiliateAccountId: "00000000-0000-4000-8000-000000000103",
  externalOfferId: "external-offer-1",
  priceCents: 125000,
  currency: "IDR",
  commissionRateBps: 500,
  commissionAmountCents: 6250,
  availability: "available",
  availabilityMetadata: {},
  affiliateUrl: "https://affiliate.example.test/offer-1",
  affiliateLinkExpiresAt: null,
  affiliateLinkStatus: "active",
  status: "active",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z"
};

test("marketplace verification repository applies the keyset cursor and bounded SQL limit", async () => {
  let selectedTable: unknown;
  let cursorCondition: unknown;
  let limitValue = 0;
  const joinedTables: unknown[] = [];
  const query = {
    leftJoin(table: unknown) { joinedTables.push(table); return this; },
    where(condition: unknown) { cursorCondition = condition; return this; },
    orderBy() { return this; },
    async limit(value: number) {
      limitValue = value;
      return [{
        offer: offerRow,
        affiliateId: null,
        affiliateName: null,
        affiliateAccountName: null,
        marketplaceSlug: null,
        productExternalId: "product-1",
        productName: "Product One",
        productUrl: "https://shop.example.test/product-1"
      }];
    }
  };
  const db = {
    select() {
      return {
        from(table: unknown) { selectedTable = table; return query; }
      };
    }
  };
  const repository = createPostgresRepositories(db as never).affiliateOffers;
  const cursor = {
    createdAt: "2026-02-01T00:00:00.000Z",
    id: "00000000-0000-4000-8000-000000000100"
  };
  const rows = await repository.listVerificationRows?.({ after: cursor, limit: 26 });

  assert.equal(selectedTable, affiliateOffers);
  assert.deepEqual(joinedTables, [affiliateAccounts, affiliates, marketplaces, products]);
  assert.equal(limitValue, 26);
  assert.equal(rows?.length, 1);
  assert.equal(rows?.[0]?.id, offerRow.id);

  const compiled = new PgDialect().sqlToQuery(cursorCondition as never);
  assert.match(compiled.sql, /created_at/);
  assert.match(compiled.sql, />/);
  assert.deepEqual(compiled.params, [cursor.createdAt, cursor.createdAt, cursor.id]);
});
