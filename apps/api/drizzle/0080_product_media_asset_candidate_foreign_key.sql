-- Keep the provenance link relationally valid while allowing product deletion
-- to cascade through both product-owned records without blocking the cascade.
ALTER TABLE public.product_media_assets
  ADD CONSTRAINT product_media_assets_source_candidate_fk
  FOREIGN KEY (source_candidate_id)
  REFERENCES public.product_media_candidates(id)
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE public.product_media_assets
  VALIDATE CONSTRAINT product_media_assets_source_candidate_fk;
