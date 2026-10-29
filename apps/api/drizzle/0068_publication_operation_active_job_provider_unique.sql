-- Prevent concurrent retries from creating multiple in-flight operations for one job/provider.
-- Existing published history is preserved; failed operations remain retryable.
CREATE UNIQUE INDEX IF NOT EXISTS publication_operations_active_job_provider_unique
  ON public.publication_operations (job_id, provider)
  WHERE status IN ('accepted', 'processing');
