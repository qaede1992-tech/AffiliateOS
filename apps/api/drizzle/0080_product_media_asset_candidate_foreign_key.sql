-- Keep the provenance link relationally valid while allowing product deletion
-- to cascade through both product-owned records without blocking the cascade.
-- The forward-repair CI path may replay this migration against a schema where
-- the constraint already exists, so verify its definition before adding it.
DO $$
DECLARE
  existing_constraint record;
BEGIN
  SELECT
    con.contype,
    con.conrelid,
    con.confrelid,
    con.confdeltype
  INTO existing_constraint
  FROM pg_constraint AS con
  WHERE con.conname = 'product_media_assets_source_candidate_fk'
    AND con.conrelid = 'public.product_media_assets'::regclass;

  IF FOUND THEN
    IF existing_constraint.contype <> 'f'
      OR existing_constraint.confrelid <> 'public.product_media_candidates'::regclass
      OR existing_constraint.confdeltype <> 'n' THEN
      RAISE EXCEPTION 'Existing product_media_assets_source_candidate_fk has an unexpected definition';
    END IF;
  ELSE
    ALTER TABLE public.product_media_assets
      ADD CONSTRAINT product_media_assets_source_candidate_fk
      FOREIGN KEY (source_candidate_id)
      REFERENCES public.product_media_candidates(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.product_media_assets
  VALIDATE CONSTRAINT product_media_assets_source_candidate_fk;
