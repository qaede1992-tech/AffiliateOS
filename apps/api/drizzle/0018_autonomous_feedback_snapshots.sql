CREATE TABLE IF NOT EXISTS autonomous_feedback_snapshots (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  click_count integer NOT NULL,
  conversion_count integer NOT NULL,
  attributed_commission_cents bigint NOT NULL,
  conversion_rate real NOT NULL,
  adjustment real NOT NULL,
  observed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS autonomous_feedback_product_observed_idx
  ON autonomous_feedback_snapshots (product_id, observed_at);
