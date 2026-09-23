ALTER TABLE autonomous_action_outcomes ADD COLUMN IF NOT EXISTS evaluation_metrics jsonb;
ALTER TABLE autonomous_action_outcomes ADD COLUMN IF NOT EXISTS evaluated_at timestamptz;
CREATE INDEX IF NOT EXISTS autonomous_action_outcomes_evaluation_idx ON autonomous_action_outcomes (campaign_id, evaluated_at, observed_at);
