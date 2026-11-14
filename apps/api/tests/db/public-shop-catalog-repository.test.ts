import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { createPostgresRepositories } from "../../src/db/repositories.js";

function createCatalogRepository(capture: (query: unknown) => void) {
  const repositories = createPostgresRepositories({
    execute: async (query: unknown) => {
      capture(query);
      return {
        rows: [{
          id: "product-1",
          reference_number: 42,
          name: "Lampu Uji",
          category: "Elektronik",
          price_cents: 125000,
          currency: "IDR",
          rating_milli: 4900,
          review_count: 8,
          tracking_code: "track-1",
          image_url: null,
          video_url: null,
          total: 37
        }]
      };
    }
  } as never);
  if (!repositories.publicShopCatalog) throw new Error("Public Shop SQL repository is not registered.");
  return repositories.publicShopCatalog;
}

test("Public Shop SQL filters eligible offers, deduplicates products, counts and bounds the ordered page", async () => {
  let captured: unknown;
  const catalog = createCatalogRepository((query) => { captured = query; });
  const page = await catalog.listPage({ query: "lampu", page: 2, pageSize: 24 });
  const compiled = new PgDialect().sqlToQuery(captured as never);

  assert.match(compiled.sql, /DISTINCT ON \(p\.id\)/);
  assert.match(compiled.sql, /p\.status = 'active'/);
  assert.match(compiled.sql, /ao\.status = 'active'/);
  assert.match(compiled.sql, /ao\.affiliate_link_status = 'active'/);
  assert.match(compiled.sql, /ao\.affiliate_link_expires_at/);
  assert.match(compiled.sql, /JOIN LATERAL/);
  assert.match(compiled.sql, /ESCAPE E'\\\\'/);
  assert.match(compiled.sql, /t\.status = 'active'/);
  assert.match(compiled.sql, /ORDER BY p\.id, ao\.created_at DESC, ao\.id DESC/);
  assert.match(compiled.sql, /count\(\*\)::integer AS total/i);
  assert.match(compiled.sql, /ORDER BY reference_number ASC NULLS LAST, id ASC LIMIT \$\d+ OFFSET \$\d+/);
  assert.ok(compiled.params.includes("%lampu%"));
  assert.ok(compiled.params.includes(24));
  assert.deepEqual(page, {
    data: [{
      id: "product-1",
      referenceNumber: 42,
      name: "Lampu Uji",
      category: "Elektronik",
      priceCents: 125000,
      currency: "IDR",
      ratingMilli: 4900,
      reviewCount: 8,
      trackingCode: "track-1",
      imageUrl: undefined,
      videoUrl: undefined
    }],
    total: 37,
    page: 2,
    pageSize: 24
  });
});

test("Public Shop SQL uses an exact reference-number predicate for numeric searches", async () => {
  let captured: unknown;
  const catalog = createCatalogRepository((query) => { captured = query; });
  await catalog.listPage({ query: "42", page: 1, pageSize: 24 });
  const compiled = new PgDialect().sqlToQuery(captured as never);

  assert.match(compiled.sql, /p\.reference_number = \$\d+/);
  assert.ok(compiled.params.includes(42));
});

test("Public Shop SQL repository rejects deep pages before executing SQL", async () => {
  let calls = 0;
  const catalog = createCatalogRepository(() => { calls += 1; });
  await assert.rejects(
    () => catalog.listPage({ query: "", page: 101, pageSize: 24 }),
    /page must be between 1 and 100/
  );
  assert.equal(calls, 0);
});
