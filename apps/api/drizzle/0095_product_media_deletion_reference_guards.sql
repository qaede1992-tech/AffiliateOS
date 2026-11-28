ALTER TABLE public.product_media_assets
  ADD COLUMN IF NOT EXISTS storage_cleanup_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS storage_cleanup_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS storage_cleanup_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS storage_cleanup_last_error varchar(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.product_media_assets'::regclass
      AND conname = 'product_media_assets_cleanup_attempts_check'
  ) THEN
    ALTER TABLE public.product_media_assets
      ADD CONSTRAINT product_media_assets_cleanup_attempts_check
      CHECK (storage_cleanup_attempts >= 0);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS product_media_assets_cleanup_due_idx
  ON public.product_media_assets (deletion_status, storage_cleanup_next_attempt_at, storage_cleanup_lease_until, deleted_at);

CREATE INDEX IF NOT EXISTS media_assets_reference_source_idx
  ON public.media_assets (source, reference);

CREATE OR REPLACE FUNCTION public.prevent_product_media_asset_reference_when_deleted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_separator integer;
  v_bucket text;
  v_object_key text;
  v_deletion_status varchar(24);
BEGIN
  IF NEW.source <> 'object-storage' THEN
    RETURN NEW;
  END IF;

  v_separator := strpos(NEW.reference, '/');
  IF v_separator <= 1 OR v_separator >= length(NEW.reference) THEN
    RETURN NEW;
  END IF;

  v_bucket := substring(NEW.reference FROM 1 FOR v_separator - 1);
  v_object_key := substring(NEW.reference FROM v_separator + 1);

  SELECT asset.deletion_status
    INTO v_deletion_status
    FROM public.product_media_assets AS asset
    WHERE asset.bucket = v_bucket
      AND asset.object_key = v_object_key
    FOR SHARE;

  IF FOUND AND v_deletion_status <> 'active' THEN
    RAISE EXCEPTION 'product media asset is not active and cannot be attached';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS media_assets_require_active_product_media
  ON public.media_assets;
CREATE TRIGGER media_assets_require_active_product_media
  BEFORE INSERT OR UPDATE OF source, reference
  ON public.media_assets
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_product_media_asset_reference_when_deleted();

CREATE OR REPLACE FUNCTION public.prevent_dispatch_snapshot_for_deleted_product_media()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_item jsonb;
  v_asset_id uuid;
  v_deletion_status varchar(24);
  v_assets jsonb;
BEGIN
  v_assets := COALESCE(NEW.snapshot #> '{mediaIntegrity,productMediaAssets}', '[]'::jsonb);
  IF jsonb_typeof(v_assets) <> 'array' THEN
    RAISE EXCEPTION 'publication media integrity productMediaAssets must be an array';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_assets) AS item(value)
  LOOP
    IF COALESCE(v_item->>'id', '') = '' THEN
      RAISE EXCEPTION 'publication media snapshot contains an invalid product media identity';
    END IF;

    BEGIN
      v_asset_id := (v_item->>'id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'publication media snapshot contains an invalid product media identity';
    END;

    SELECT asset.deletion_status
      INTO v_deletion_status
      FROM public.product_media_assets AS asset
      WHERE asset.id = v_asset_id
      FOR SHARE;

    IF NOT FOUND OR v_deletion_status <> 'active' THEN
      RAISE EXCEPTION 'publication media snapshot references a missing or deleted product media asset';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS publication_reservations_require_active_product_media
  ON public.publication_dispatch_reservations;
CREATE TRIGGER publication_reservations_require_active_product_media
  BEFORE INSERT OR UPDATE OF snapshot
  ON public.publication_dispatch_reservations
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_dispatch_snapshot_for_deleted_product_media();

REVOKE EXECUTE ON FUNCTION public.prevent_product_media_asset_reference_when_deleted() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_dispatch_snapshot_for_deleted_product_media() FROM PUBLIC;
