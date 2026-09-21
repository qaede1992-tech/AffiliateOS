ALTER TABLE autonomous_feedback_snapshots
  ADD COLUMN IF NOT EXISTS observation_key varchar(500);

UPDATE autonomous_feedback_snapshots
SET observation_key = product_id::text || ':' || observed_at::text || ':' || id::text
WHERE observation_key IS NULL;

ALTER TABLE autonomous_feedback_snapshots
  ALTER COLUMN observation_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS autonomous_feedback_observation_unique
  ON autonomous_feedback_snapshots (observation_key);
