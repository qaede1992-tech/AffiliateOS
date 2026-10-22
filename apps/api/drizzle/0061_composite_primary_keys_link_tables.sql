-- Convert existing unique natural keys to primary keys without changing rows.
-- Preconditions: the existing unique keys must be present and both key columns NOT NULL.
ALTER TABLE campaign_offers
  ADD CONSTRAINT campaign_offers_pkey
  PRIMARY KEY USING INDEX campaign_offers_unique;

ALTER TABLE content_products
  DROP CONSTRAINT content_products_content_product_unique;

ALTER TABLE content_products
  ADD CONSTRAINT content_products_pkey
  PRIMARY KEY (content_id, product_id);
