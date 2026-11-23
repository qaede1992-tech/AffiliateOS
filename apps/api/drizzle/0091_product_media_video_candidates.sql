ALTER TABLE public.product_media_candidates
  ADD COLUMN IF NOT EXISTS media_kind varchar(10) NOT NULL DEFAULT 'image',
  ADD COLUMN IF NOT EXISTS video_url varchar(2048);

ALTER TABLE public.product_media_candidates
  ALTER COLUMN image_url DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_media_candidates_media_kind_check'
      AND conrelid = 'public.product_media_candidates'::regclass
  ) THEN
    ALTER TABLE public.product_media_candidates
      ADD CONSTRAINT product_media_candidates_media_kind_check
      CHECK (
        (media_kind = 'image' AND image_url IS NOT NULL AND video_url IS NULL)
        OR
        (media_kind = 'video' AND image_url IS NULL AND video_url IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_media_candidates_media_kind_allowed_check'
      AND conrelid = 'public.product_media_candidates'::regclass
  ) THEN
    ALTER TABLE public.product_media_candidates
      ADD CONSTRAINT product_media_candidates_media_kind_allowed_check
      CHECK (media_kind IN ('image', 'video'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS product_media_candidates_product_kind_review_idx
  ON public.product_media_candidates (product_id, media_kind, review_status);
