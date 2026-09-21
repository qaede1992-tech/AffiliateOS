CREATE UNIQUE INDEX IF NOT EXISTS clicks_tracking_link_idempotency_unique
  ON clicks (tracking_link_id, idempotency_key);

CREATE INDEX IF NOT EXISTS clicks_tracking_link_occurred_idx
  ON clicks (tracking_link_id, occurred_at);
