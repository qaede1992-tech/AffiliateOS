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


test("real Shopee import rolls back every earlier write when the second offer insert fails", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  const repositories = createPostgresRepositories(db);
  const transactions = new DrizzleTransactionManager(db);
  const suffix = randomUUID().replace(/-/g, "");
  const affiliateId = randomUUID();
  const firstProductId = `rollback-a-${suffix}`;
  const secondProductId = `rollback-b-${suffix}`;
  const functionName = `affiliateos_rollback_probe_${suffix}`;
  const triggerName = `affiliateos_rollback_trigger_${suffix}`;
  const failingOfferId = `feed:${secondProductId}`;
  const timestamp = new Date().toISOString();

  try {
    await repositories.affiliates.save({
      id: affiliateId,
      name: "Shopee rollback probe",
      email: `rollback-probe-${suffix}@example.invalid`,
      status: "active",
      createdAt: timestamp,
    });

    await pool.query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.external_offer_id = '${failingOfferId}' THEN
          RAISE EXCEPTION 'injected failure on second Shopee offer';
        END IF;
        RETURN NEW;
      END;
      $body$;
    `);
    await pool.query(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT OR UPDATE ON affiliate_offers
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()
    `);

    const { MarketplaceProviderRegistry } = await import("../../src/domain/foundations.js");
    const { MarketplaceService } = await import("../../src/domain/marketplace.js");
    const service = new MarketplaceService(
      new MarketplaceProviderRegistry(),
      repositories.marketplaceConnections,
      repositories.products,
      repositories.affiliateAccounts,
      repositories.affiliates,
      repositories.affiliateOffers,
      repositories.offers,
      transactions,
    );
    const product = (externalProductId: string, name: string) => ({
      externalProductId,
      externalOfferId: `feed:${externalProductId}`,
      name,
      priceCents: 10000,
      currency: "IDR",
      productUrl: "https://shopee.co.id/product/1/123",
      affiliateUrl: "https://s.shopee.co.id/rollback-probe",
      availability: "unknown" as const,
      commissionRateBps: 500,
      commissionAmountCents: 1000,
    });

    await assert.rejects(
      service.importShopeeAffiliateFeed({
        affiliateId,
        sourceReference: `rollback-test-${suffix}`,
        items: [
          product(firstProductId, "Rollback probe first product"),
          product(secondProductId, "Rollback probe second product"),
        ],
      }),
      /injected failure on second Shopee offer/,
    );

    assert.ok(await repositories.affiliates.findById(affiliateId), "the pre-existing affiliate should remain");
    assert.equal(await repositories.marketplaceConnections.findBySlug("shopee-affiliate-feed"), undefined);
    const products = await repositories.products.list();
    assert.equal(products.some((item) => item.externalProductId === firstProductId), false);
    assert.equal(products.some((item) => item.externalProductId === secondProductId), false);
    const affiliateOffers = await repositories.affiliateOffers.list();
    assert.equal(affiliateOffers.some((item) => item.externalOfferId === `feed:${firstProductId}`), false);
    assert.equal(affiliateOffers.some((item) => item.externalOfferId === failingOfferId), false);
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON affiliate_offers`).catch(() => undefined);
    await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => undefined);
    await pool.end();
  }
});
