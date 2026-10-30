-- Forward-only recovery for installations where migration 0067 was skipped
-- because a later journal entry had already advanced the Drizzle ledger.
ALTER TABLE public.publication_jobs
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE public.publication_jobs
  ADD COLUMN IF NOT EXISTS tiktok_approval jsonb;
ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS duration_seconds integer;
CREATE TABLE IF NOT EXISTS public.content_products (
  content_id uuid NOT NULL REFERENCES public.content(id),
  product_id uuid NOT NULL REFERENCES public.products(id),
  affiliate_offer_id uuid REFERENCES public.affiliate_offers(id),
  position integer NOT NULL DEFAULT 0,
  role varchar(30) NOT NULL DEFAULT 'recommendation',
  created_at timestamptz NOT NULL,
  CONSTRAINT content_products_pkey PRIMARY KEY (content_id, product_id)
);
CREATE INDEX IF NOT EXISTS content_products_product_idx ON public.content_products(product_id);
CREATE INDEX IF NOT EXISTS content_products_offer_idx ON public.content_products(affiliate_offer_id);
CREATE INDEX IF NOT EXISTS content_products_content_position_idx ON public.content_products(content_id, position);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.content_products TO affiliateos_runtime;
ALTER TABLE public.content_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS affiliateos_runtime_access ON public.content_products;
CREATE POLICY affiliateos_runtime_access ON public.content_products FOR ALL TO affiliateos_runtime USING (true) WITH CHECK (true);
