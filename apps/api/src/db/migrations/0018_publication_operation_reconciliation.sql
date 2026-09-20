ALTER TABLE publication_operations
  ADD COLUMN IF NOT EXISTS check_attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE publication_operations
  ADD COLUMN IF NOT EXISTS next_check_at timestamptz;

CREATE INDEX IF NOT EXISTS publication_operations_next_check_idx
  ON publication_operations (status, next_check_at);
