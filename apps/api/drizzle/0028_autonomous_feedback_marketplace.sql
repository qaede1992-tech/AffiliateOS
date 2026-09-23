ALTER TABLE autonomous_feedback_snapshots
  ADD COLUMN IF NOT EXISTS marketplace_id uuid;

UPDATE autonomous_feedback_snapshots afs
SET marketplace_id = p.marketplace_id
FROM products p
WHERE p.id = afs.product_id
  AND afs.marketplace_id IS NULL;

ALTER TABLE autonomous_feedback_snapshots
  ALTER COLUMN marketplace_id SET NOT NULL;

ALTER TABLE autonomous_feedback_snapshots
  ADD CONSTRAINT autonomous_feedback_marketplace_fk
  FOREIGN KEY (marketplace_id) REFERENCES marketplaces(id);

CREATE INDEX IF NOT EXISTS autonomous_feedback_marketplace_product_observed_idx
  ON autonomous_feedback_snapshots (marketplace_id, product_id, observed_at);
