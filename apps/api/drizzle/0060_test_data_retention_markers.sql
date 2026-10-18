ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

ALTER TABLE autonomous_runs
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS campaigns_test_created_idx
  ON campaigns (is_test, created_at);

CREATE INDEX IF NOT EXISTS autonomous_runs_test_created_idx
  ON autonomous_runs (is_test, created_at);
