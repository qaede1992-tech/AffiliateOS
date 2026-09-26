ALTER TABLE "provider_events" ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "provider_events" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz;
CREATE INDEX IF NOT EXISTS "provider_events_retry_idx" ON "provider_events" ("status", "next_attempt_at", "received_at");
