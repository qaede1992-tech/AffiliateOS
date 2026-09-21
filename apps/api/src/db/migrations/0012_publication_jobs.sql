CREATE TABLE IF NOT EXISTS publication_jobs (
  id uuid PRIMARY KEY,
  content_id uuid NOT NULL REFERENCES content(id),
  idempotency_key varchar(200) NOT NULL,
  status varchar(20) NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  scheduled_at timestamptz NOT NULL,
  locked_at timestamptz,
  external_post_id varchar(500),
  last_error varchar(2000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT publication_jobs_idempotency_unique UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS publication_jobs_due_idx
  ON publication_jobs (status, scheduled_at);

CREATE INDEX IF NOT EXISTS publication_jobs_lock_idx
  ON publication_jobs (status, locked_at);
