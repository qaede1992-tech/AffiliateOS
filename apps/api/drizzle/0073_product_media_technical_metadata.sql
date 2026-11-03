ALTER TABLE public.product_media_assets
  ADD COLUMN IF NOT EXISTS width_px integer,
  ADD COLUMN IF NOT EXISTS height_px integer,
  ADD COLUMN IF NOT EXISTS duration_ms bigint,
  ADD COLUMN IF NOT EXISTS has_audio boolean;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.product_media_assets'::regclass AND conname = 'product_media_assets_dimensions_positive_check') THEN
    ALTER TABLE public.product_media_assets
      ADD CONSTRAINT product_media_assets_dimensions_positive_check
      CHECK ((width_px IS NULL OR width_px > 0) AND (height_px IS NULL OR height_px > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.product_media_assets'::regclass AND conname = 'product_media_assets_duration_positive_check') THEN
    ALTER TABLE public.product_media_assets
      ADD CONSTRAINT product_media_assets_duration_positive_check
      CHECK (duration_ms IS NULL OR duration_ms > 0);
  END IF;
END $$;
