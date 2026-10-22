-- Convert existing unique natural keys to primary keys without changing rows.
-- The explicit unique index name is not guaranteed in drifted databases, so
-- create the primary key from the columns rather than USING INDEX.
ALTER TABLE campaign_offers
  ADD CONSTRAINT campaign_offers_pkey
  PRIMARY KEY (campaign_id, affiliate_offer_id);

-- The primary key now enforces the same uniqueness; remove the redundant
-- standalone Drizzle unique index when it exists.
DROP INDEX IF EXISTS campaign_offers_unique;

ALTER TABLE content_products
  DROP CONSTRAINT content_products_content_product_unique;

ALTER TABLE content_products
  ADD CONSTRAINT content_products_pkey
  PRIMARY KEY (content_id, product_id);
