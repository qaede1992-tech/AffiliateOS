ALTER TABLE affiliate_offers
  ADD COLUMN IF NOT EXISTS affiliate_link_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS affiliate_offers_link_expiry_idx
  ON affiliate_offers (affiliate_link_status, affiliate_link_expires_at);
