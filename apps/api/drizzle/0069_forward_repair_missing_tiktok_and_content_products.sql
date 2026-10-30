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

-- CREATE TABLE IF NOT EXISTS does not repair a partially-created relation.
-- Add the expected constraints independently so this migration repairs both
-- a missing table and an incomplete table left by an interrupted deployment.
DO $repair$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.content_products'::regclass
       AND contype = 'p'
       AND pg_get_constraintdef(oid, true) = 'PRIMARY KEY (content_id, product_id)'
  ) THEN
    ALTER TABLE public.content_products
      ADD CONSTRAINT content_products_pkey PRIMARY KEY (content_id, product_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.content_products'::regclass
       AND contype = 'f'
       AND pg_get_constraintdef(oid, true) LIKE 'FOREIGN KEY (content_id) REFERENCES content(id)%'
  ) THEN
    ALTER TABLE public.content_products
      ADD CONSTRAINT content_products_content_id_fkey
      FOREIGN KEY (content_id) REFERENCES public.content(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.content_products'::regclass
       AND contype = 'f'
       AND pg_get_constraintdef(oid, true) LIKE 'FOREIGN KEY (product_id) REFERENCES products(id)%'
  ) THEN
    ALTER TABLE public.content_products
      ADD CONSTRAINT content_products_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES public.products(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.content_products'::regclass
       AND contype = 'f'
       AND pg_get_constraintdef(oid, true) LIKE 'FOREIGN KEY (affiliate_offer_id) REFERENCES affiliate_offers(id)%'
  ) THEN
    ALTER TABLE public.content_products
      ADD CONSTRAINT content_products_affiliate_offer_id_fkey
      FOREIGN KEY (affiliate_offer_id) REFERENCES public.affiliate_offers(id);
  END IF;
END
$repair$;
