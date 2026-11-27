ALTER TABLE public.product_media_assets
  ADD COLUMN IF NOT EXISTS storage_backend varchar(20) NOT NULL DEFAULT 'supabase';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_media_assets_storage_backend_check'
      AND conrelid = 'public.product_media_assets'::regclass
  ) THEN
    ALTER TABLE public.product_media_assets
      ADD CONSTRAINT product_media_assets_storage_backend_check
      CHECK (storage_backend IN ('supabase', 'local_volume'));
  END IF;
END $$;
