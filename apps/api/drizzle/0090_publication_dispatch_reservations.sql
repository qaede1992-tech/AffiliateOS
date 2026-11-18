-- Durable pre-dispatch reservation for external publication providers.
-- The unique job/provider key ensures concurrent workers share one dispatch record.
CREATE TABLE public.publication_dispatch_reservations (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.publication_jobs(id),
  content_id uuid NOT NULL REFERENCES public.content(id),
  provider varchar(100) NOT NULL,
  state varchar(32) NOT NULL CHECK (state IN ('reserved','dispatching','accepted','uncertain','needs_reconciliation','published','failed','safe_to_retry')),
  idempotency_key varchar(200) NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_hash varchar(128) NOT NULL,
  dispatch_started_at timestamptz,
  provider_operation_id varchar(500),
  external_post_id varchar(500),
  last_error varchar(2000),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT publication_dispatch_reservations_job_provider_unique UNIQUE (job_id, provider),
  CONSTRAINT publication_dispatch_reservations_idempotency_unique UNIQUE (idempotency_key)
);
--> statement-breakpoint
CREATE INDEX publication_dispatch_reservations_state_updated_idx
  ON public.publication_dispatch_reservations (state, updated_at);
--> statement-breakpoint
ALTER TABLE public.publication_dispatch_reservations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY affiliateos_runtime_access ON public.publication_dispatch_reservations
  FOR ALL TO affiliateos_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.publication_dispatch_reservations TO affiliateos_runtime;
