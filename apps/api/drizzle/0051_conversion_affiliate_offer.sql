ALTER TABLE conversions
  ADD COLUMN affiliate_offer_id uuid REFERENCES affiliate_offers(id);

CREATE INDEX conversions_affiliate_offer_idx
  ON conversions (affiliate_offer_id);
