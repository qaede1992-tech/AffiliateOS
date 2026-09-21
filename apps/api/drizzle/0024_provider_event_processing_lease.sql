ALTER TABLE provider_events
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

CREATE INDEX IF NOT EXISTS provider_events_processing_idx
  ON provider_events (status, processing_started_at);
