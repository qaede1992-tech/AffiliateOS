import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const migrationsDirectory = resolve(import.meta.dirname, "../drizzle");
test("tracked Drizzle migrations form a complete, ordered history", async () => { const journal = JSON.parse(await readFile(resolve(migrationsDirectory, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> }; const files = new Set((await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql"))); assert.ok(journal.entries.every((entry, index) => index === 0 || entry.idx > journal.entries[index - 1].idx), "migration journal indices must be strictly increasing"); assert.equal(new Set(journal.entries.map((entry) => entry.tag)).size, journal.entries.length, "migration tags must be unique"); for (const entry of journal.entries) assert.ok(files.delete(`${entry.tag}.sql`), `missing ${entry.tag}.sql`); assert.equal(files.size, 0, "every migration SQL file must be listed in the Drizzle journal"); });
test("integration readiness migration stores state and health metadata without secret columns", async () => { const sql = await readFile(resolve(migrationsDirectory, "0004_marketplace_integration_readiness.sql"), "utf8"); for (const column of ["connection_mode", "enabled", "health_status", "health_metadata", "last_successful_check_at"]) assert.match(sql, new RegExp(column)); assert.doesNotMatch(sql, /api_key|access_token|client_secret|password/i); });
test("marketplace engine migration stores provider references and affiliate-link state without credentials", async () => { const sql = await readFile(resolve(migrationsDirectory, "0003_marketplace_engine.sql"), "utf8"); assert.match(sql, /provider_slug/); assert.match(sql, /credential_reference/); assert.match(sql, /affiliate_link_status/); assert.doesNotMatch(sql, /api_secret|access_token|client_secret/i); });
test("click idempotency migration adds a per-link uniqueness boundary without storing secrets", async () => { const sql = await readFile(resolve(migrationsDirectory, "0005_click_idempotency.sql"), "utf8"); assert.match(sql, /ADD COLUMN IF NOT EXISTS "idempotency_key" varchar\(200\)/); assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "clicks_link_idempotency_unique" ON "clicks" \("tracking_link_id", "idempotency_key"\)/); assert.doesNotMatch(sql, /api_key|access_token|client_secret|password/i); });
test("OAuth state migration stores only transient state metadata", async () => { const sql = await readFile(resolve(migrationsDirectory, "0006_oauth_states.sql"), "utf8"); assert.match(sql, /CREATE TABLE IF NOT EXISTS "oauth_states"/); assert.match(sql, /expires_at/); assert.doesNotMatch(sql, /token|secret|password|credential/i); });
test("conversion attribution migration creates an explicit one-to-one relationship", async () => { const sql = await readFile(resolve(migrationsDirectory, "0007_conversion_attributions.sql"), "utf8"); assert.match(sql, /CREATE TABLE IF NOT EXISTS "conversion_attributions"/); assert.match(sql, /"conversion_id" uuid PRIMARY KEY REFERENCES "conversions"/); assert.match(sql, /"tracking_link_id" uuid NOT NULL REFERENCES "tracking_links"/); assert.match(sql, /conversion_attributions_tracking_link_idx/); assert.doesNotMatch(sql, /api_key|access_token|client_secret|password/i); });
test("conversion idempotency migration adds a unique event boundary without storing secrets", async () => { const sql = await readFile(resolve(migrationsDirectory, "0008_conversion_idempotency.sql"), "utf8"); assert.match(sql, /ADD COLUMN IF NOT EXISTS "idempotency_key" varchar\(200\)/); assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "conversions_idempotency_unique" ON "conversions" \("idempotency_key"\)/); assert.doesNotMatch(sql, /api_key|access_token|client_secret|password/i); });
test("foundation schema and its omitted tracking-links index are both tracked", async () => { const foundationSql = await readFile(resolve(migrationsDirectory, "0001_affiliateos_foundation.sql"), "utf8"); const indexSql = await readFile(resolve(migrationsDirectory, "0002_tracking_links_campaign_index.sql"), "utf8"); for (const table of ["marketplaces", "affiliate_accounts", "products", "affiliate_offers", "campaigns", "campaign_offers", "tracking_links", "clicks", "social_accounts", "content"]) assert.match(foundationSql, new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`)); assert.match(indexSql, /CREATE INDEX IF NOT EXISTS "tracking_links_campaign_idx" ON "tracking_links" \("campaign_id"\)/); });

test("provider event retry migration persists bounded backoff state without credentials", async () => {
  const sql = await readFile(resolve(migrationsDirectory, "0054_provider_event_retry_backoff.sql"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "provider_events_retry_idx" ON "provider_events" \("status", "next_attempt_at", "received_at"\)/);
  assert.doesNotMatch(sql, /api_key|access_token|client_secret|password/i);
});


test("illustrative creative provenance is isolated from third-party product-media rights and disabled by default", async () => {
  const sql = await readFile(resolve(migrationsDirectory, "0093_illustrative_creative_provenance.sql"), "utf8");
  assert.match(sql, /CREATE TABLE public\.illustrative_creative_policies/);
  assert.match(sql, /enabled boolean NOT NULL DEFAULT false/);
  assert.match(sql, /approved_by varchar\(255\)/);
  assert.match(sql, /CREATE TABLE public\.generated_product_creatives/);
  assert.match(sql, /media_asset_id uuid NOT NULL REFERENCES public\.media_assets/);
  assert.match(sql, /CREATE UNIQUE INDEX generated_product_creatives_media_asset_unique ON public\.generated_product_creatives\(media_asset_id\)/);
  assert.match(sql, /product_snapshot jsonb NOT NULL/);
  assert.match(sql, /disclosure_embedded boolean NOT NULL DEFAULT false/);
  assert.match(sql, /CHECK \(disclosure_embedded = true\)/);
  assert.match(sql, /review_status varchar\(20\) NOT NULL DEFAULT 'pending'/);
  assert.match(sql, /CREATE TABLE public\.generated_product_creative_review_audits/);
  assert.match(sql, /CREATE TABLE public\.illustrative_creative_policy_audits/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /TO affiliateos_runtime USING \(true\) WITH CHECK \(true\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);
  assert.doesNotMatch(sql, /INSERT INTO public\.illustrative_creative_policies/i);
  assert.doesNotMatch(sql, /UPDATE public\.product_media_assets|rights_status|rights_basis/i);
});

test("illustrative creative storage metadata permits only opaque local-volume keys", async () => {
  const sql = await readFile(resolve(migrationsDirectory, "0094_illustrative_creative_storage_metadata.sql"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS storage_backend varchar\(30\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS storage_key varchar\(255\)/);
  assert.match(sql, /storage_backend = 'local_volume'/);
  assert.match(sql, /storage_key IS NOT NULL/);
  assert.match(sql, /storage_key ~ '\^\[0-9a-f\]/);

  assert.match(sql, /storage_backend IS NULL AND storage_key IS NULL/);
  assert.match(sql, /storage_backend IS NOT NULL\s+AND storage_backend = 'local_volume'/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS generated_product_creatives_storage_key_unique/);
  assert.doesNotMatch(sql, /absolute_path|filesystem_path|https?:\/\//i);
});
