ALTER TABLE autonomous_feedback_snapshots
  ADD COLUMN IF NOT EXISTS commission_per_click_cents real NOT NULL DEFAULT 0;

UPDATE autonomous_feedback_snapshots
SET commission_per_click_cents = CASE
  WHEN click_count > 0 THEN attributed_commission_cents::real / click_count
  ELSE 0
END;
