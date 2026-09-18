-- Keep the migration history immutable: this index was declared in the Drizzle
-- schema but was omitted from the original additive foundation migration.
CREATE INDEX IF NOT EXISTS "tracking_links_campaign_idx" ON "tracking_links" ("campaign_id");
