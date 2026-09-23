ALTER TABLE autonomous_action_outcomes ADD COLUMN IF NOT EXISTS baseline_metrics jsonb;
ALTER TABLE autonomous_action_outcomes ADD COLUMN IF NOT EXISTS observed_metrics jsonb;
