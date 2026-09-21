CREATE TABLE IF NOT EXISTS autonomous_optimization_states (
  campaign_id uuid PRIMARY KEY REFERENCES campaigns(id),
  action varchar(30) NOT NULL,
  applied_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
