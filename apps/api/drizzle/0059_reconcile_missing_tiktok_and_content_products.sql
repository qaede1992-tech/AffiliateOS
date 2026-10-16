-- Forward-only reconciliation for production databases where 0056/0057 are
-- absent from the Drizzle ledger and their schema objects are absent.
-- Journal timestamps for 0056/0057 are lower than a later historical entry, so
-- Drizzle may skip them even on a clean database. This forward migration must
-- create the expected objects whether or not 0056/0057 ran.
-- Do not use this migration to conceal partial or incompatible pre-existing objects;
-- the production preflight must confirm the audited starting state first.
ALTER TABLE publication_jobs
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

ALTER TABLE publication_jobs
  ADD COLUMN IF NOT EXISTS tiktok_approval jsonb;

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS duration_seconds integer;

CREATE TABLE IF NOT EXISTS content_products (
  content_id uuid NOT NULL REFERENCES content(id),
  product_id uuid NOT NULL REFERENCES products(id),
  affiliate_offer_id uuid REFERENCES affiliate_offers(id),
  position integer NOT NULL DEFAULT 0,
  role varchar(30) NOT NULL DEFAULT 'recommendation',
  created_at timestamptz NOT NULL,
  CONSTRAINT content_products_content_product_unique UNIQUE (content_id, product_id)
);

CREATE INDEX IF NOT EXISTS content_products_product_idx ON content_products(product_id);
CREATE INDEX IF NOT EXISTS content_products_offer_idx ON content_products(affiliate_offer_id);
CREATE INDEX IF NOT EXISTS content_products_content_position_idx ON content_products(content_id, position);
