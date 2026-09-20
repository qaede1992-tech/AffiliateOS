CREATE TABLE IF NOT EXISTS autonomous_runs (
  id uuid PRIMARY KEY,
  idempotency_key varchar(500) NOT NULL,
  opportunity_product_id uuid NOT NULL REFERENCES products(id),
  offer_id uuid NOT NULL REFERENCES affiliate_offers(id),
  campaign_id uuid REFERENCES campaigns(id),
  status varchar(20) NOT NULL,
  last_error varchar(2000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT autonomous_runs_idempotency_key_unique UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS autonomous_runs_status_idx
  ON autonomous_runs (status);

CREATE INDEX IF NOT EXISTS autonomous_runs_product_idx
  ON autonomous_runs (opportunity_product_id);
