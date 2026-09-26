CREATE INDEX IF NOT EXISTS "publication_jobs_retry_idx" ON "publication_jobs" ("status", "updated_at");
