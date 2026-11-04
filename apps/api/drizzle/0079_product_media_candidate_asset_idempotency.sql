CREATE UNIQUE INDEX IF NOT EXISTS product_media_assets_source_candidate_unique
  ON public.product_media_assets (source_candidate_id)
  WHERE source_candidate_id IS NOT NULL;
