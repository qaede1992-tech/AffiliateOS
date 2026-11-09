CREATE TABLE IF NOT EXISTS public.product_media_discovery_attempts (
  product_id uuid PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  fingerprint varchar(64) NOT NULL,
  status varchar(20) NOT NULL,
  next_retry_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
