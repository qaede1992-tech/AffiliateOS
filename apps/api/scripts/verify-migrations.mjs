import { Client } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required. Copy .env.example to .env and start PostgreSQL first.");
}

const client = new Client({ connectionString });
const expectedTables = [
  "affiliates", "offers", "conversions", "commissions", "marketplaces", "affiliate_accounts",
  "products", "affiliate_offers", "campaigns", "campaign_offers", "tracking_links", "clicks",
  "social_accounts", "content"
];
const expectedIndexes = [
  "tracking_links_campaign_idx", "products_marketplace_external_unique", "commissions_conversion_unique"
];

await client.connect();
try {
  const { rows: tableRows } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
    [expectedTables]
  );
  const actualTables = new Set(tableRows.map((row) => row.table_name));
  const missingTables = expectedTables.filter((table) => !actualTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`Missing expected tables: ${missingTables.join(", ")}.`);
  }

  const { rows: indexRows } = await client.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])",
    [expectedIndexes]
  );
  const actualIndexes = new Set(indexRows.map((row) => row.indexname));
  const missingIndexes = expectedIndexes.filter((index) => !actualIndexes.has(index));
  if (missingIndexes.length > 0) {
    throw new Error(`Missing expected indexes: ${missingIndexes.join(", ")}.`);
  }

  const { rows: migrationRows } = await client.query('SELECT COUNT(*)::int AS count FROM "__drizzle_migrations"');
  if (migrationRows[0].count < 3) {
    throw new Error("Drizzle migration ledger does not contain every tracked migration.");
  }

  console.log("PostgreSQL schema and Drizzle migration ledger verified.");
} finally {
  await client.end();
}
