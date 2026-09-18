import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const migrationsDirectory = resolve(import.meta.dirname, "../drizzle");

test("tracked Drizzle migrations form a complete, ordered history", async () => {
  const journal = JSON.parse(await readFile(resolve(migrationsDirectory, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const files = new Set((await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")));

  assert.deepEqual(journal.entries.map((entry) => entry.idx), journal.entries.map((_, index) => index));
  assert.deepEqual(journal.entries.map((entry) => entry.tag), [
    "0000_initial",
    "0001_affiliateos_foundation",
    "0002_tracking_links_campaign_index"
  ]);
  for (const entry of journal.entries) {
    assert.ok(files.delete(`${entry.tag}.sql`), `missing ${entry.tag}.sql`);
  }
  assert.equal(files.size, 0, "every migration SQL file must be listed in the Drizzle journal");
});

test("foundation schema and its omitted tracking-links index are both tracked", async () => {
  const foundationSql = await readFile(resolve(migrationsDirectory, "0001_affiliateos_foundation.sql"), "utf8");
  const indexSql = await readFile(resolve(migrationsDirectory, "0002_tracking_links_campaign_index.sql"), "utf8");

  for (const table of ["marketplaces", "affiliate_accounts", "products", "affiliate_offers", "campaigns", "campaign_offers", "tracking_links", "clicks", "social_accounts", "content"]) {
    assert.match(foundationSql, new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`));
  }
  assert.match(indexSql, /CREATE INDEX IF NOT EXISTS "tracking_links_campaign_idx" ON "tracking_links" \("campaign_id"\)/);
});
