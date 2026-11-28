ALTER TABLE public.product_media_assets
  ADD COLUMN IF NOT EXISTS deletion_status varchar(24) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by varchar(255),
  ADD COLUMN IF NOT EXISTS deletion_reason varchar(1000),
  ADD COLUMN IF NOT EXISTS storage_cleanup_completed_at timestamptz;

ALTER TABLE public.product_media_assets
  ADD CONSTRAINT product_media_assets_deletion_status_check
  CHECK (deletion_status IN ('active', 'pending_cleanup', 'cleanup_failed', 'deleted'));

ALTER TABLE public.product_media_assets
  ADD CONSTRAINT product_media_assets_deletion_metadata_check
  CHECK (
    (deletion_status = 'active' AND deleted_at IS NULL AND deleted_by IS NULL AND deletion_reason IS NULL)
    OR
    (deletion_status <> 'active' AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND deletion_reason IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS product_media_assets_deletion_status_created_idx
  ON public.product_media_assets (deletion_status, created_at);

CREATE TABLE public.product_media_deletion_audits (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES public.product_media_assets(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  actor_id varchar(255) NOT NULL,
  actor_role varchar(20) NOT NULL,
  reason varchar(1000) NOT NULL,
  storage_backend varchar(20) NOT NULL,
  bucket varchar(100) NOT NULL,
  object_key varchar(1024) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX product_media_deletion_audits_asset_created_idx
  ON public.product_media_deletion_audits (asset_id, created_at DESC);
CREATE FUNCTION public.prevent_product_media_deletion_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'product media deletion audits are append-only';
END;
$$;

CREATE TRIGGER product_media_deletion_audits_append_only
  BEFORE UPDATE OR DELETE ON public.product_media_deletion_audits
  FOR EACH ROW EXECUTE FUNCTION public.prevent_product_media_deletion_audit_mutation();
