CREATE TABLE IF NOT EXISTS public.product_media_discovery_attempts (
  product_id uuid PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  fingerprint varchar(64) NOT NULL,
  status varchar(20) NOT NULL,
  next_retry_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_media_discovery_attempts_retry_idx
  ON public.product_media_discovery_attempts (next_retry_at);
