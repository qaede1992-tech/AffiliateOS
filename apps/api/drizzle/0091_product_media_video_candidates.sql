ALTER TABLE public.product_media_candidates
  ADD COLUMN IF NOT EXISTS media_kind varchar(10) NOT NULL DEFAULT 'image',
  ADD COLUMN IF NOT EXISTS video_url varchar(2048);

ALTER TABLE public.product_media_candidates
  ALTER COLUMN image_url DROP NOT NULL;

ALTER TABLE public.product_media_candidates
  ADD CONSTRAINT product_media_candidates_media_kind_check
  CHECK (
    (media_kind = 'image' AND image_url IS NOT NULL AND video_url IS NULL)
    OR
    (media_kind = 'video' AND image_url IS NULL AND video_url IS NOT NULL)
  );

ALTER TABLE public.product_media_candidates
  ADD CONSTRAINT product_media_candidates_media_kind_allowed_check
  CHECK (media_kind IN ('image', 'video'));

CREATE INDEX IF NOT EXISTS product_media_candidates_product_kind_review_idx
  ON public.product_media_candidates (product_id, media_kind, review_status);
