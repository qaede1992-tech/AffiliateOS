ALTER TABLE autonomous_runs
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS autonomous_runs_retry_idx
  ON autonomous_runs (status, next_attempt_at, updated_at);
