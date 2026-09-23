CREATE TABLE IF NOT EXISTS autonomous_action_outcomes (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  action varchar(20) NOT NULL,
  status varchar(20) NOT NULL,
  mutated boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  error varchar(2000)
);
CREATE INDEX IF NOT EXISTS autonomous_action_outcomes_campaign_observed_idx ON autonomous_action_outcomes (campaign_id, observed_at);
CREATE INDEX IF NOT EXISTS autonomous_action_outcomes_status_observed_idx ON autonomous_action_outcomes (status, observed_at);
