ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS width_px integer,
  ADD COLUMN IF NOT EXISTS height_px integer,
  ADD COLUMN IF NOT EXISTS has_audio boolean;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.media_assets'::regclass
      AND conname = 'media_assets_dimensions_positive_check'
  ) THEN
    ALTER TABLE public.media_assets
      ADD CONSTRAINT media_assets_dimensions_positive_check
      CHECK (
        (width_px IS NULL AND height_px IS NULL)
        OR (width_px IS NOT NULL AND height_px IS NOT NULL AND width_px > 0 AND height_px > 0)
      );
  END IF;
END $$;
