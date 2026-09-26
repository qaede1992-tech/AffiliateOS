ALTER TABLE affiliate_accounts
  ADD COLUMN affiliate_id uuid REFERENCES affiliates(id);

CREATE INDEX affiliate_accounts_affiliate_idx
  ON affiliate_accounts (affiliate_id);
