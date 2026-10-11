CREATE TABLE content_products (
  content_id uuid NOT NULL REFERENCES content(id),
  product_id uuid NOT NULL REFERENCES products(id),
  affiliate_offer_id uuid REFERENCES affiliate_offers(id),
  position integer NOT NULL DEFAULT 0,
  role varchar(30) NOT NULL DEFAULT 'recommendation',
  created_at timestamptz NOT NULL,
  CONSTRAINT content_products_content_product_unique UNIQUE (content_id, product_id)
);

CREATE INDEX content_products_product_idx ON content_products(product_id);
CREATE INDEX content_products_offer_idx ON content_products(affiliate_offer_id);
CREATE INDEX content_products_content_position_idx ON content_products(content_id, position);
