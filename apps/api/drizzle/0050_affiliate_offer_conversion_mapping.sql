ALTER TABLE affiliate_offers
  ADD COLUMN conversion_offer_id uuid REFERENCES offers(id);

CREATE INDEX affiliate_offers_conversion_offer_idx
  ON affiliate_offers (conversion_offer_id);
