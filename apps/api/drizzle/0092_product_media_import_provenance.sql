ALTER TABLE public.product_media_assets
  ADD COLUMN IF NOT EXISTS source_import_provider varchar(40),
  ADD COLUMN IF NOT EXISTS source_import_reference varchar(255),
  ADD COLUMN IF NOT EXISTS source_imported_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_media_assets_source_import_provider_check'
      AND conrelid = 'public.product_media_assets'::regclass
  ) THEN
    ALTER TABLE public.product_media_assets
      ADD CONSTRAINT product_media_assets_source_import_provider_check
      CHECK (source_import_provider IS NULL OR source_import_provider IN ('shopee-affiliate-csv'));
  END IF;
END $$;
