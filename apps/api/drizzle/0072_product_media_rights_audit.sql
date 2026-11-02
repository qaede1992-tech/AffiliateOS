CREATE TABLE IF NOT EXISTS public.product_media_rights_audits (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES public.product_media_assets(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  actor_id varchar(255) NOT NULL,
  actor_role varchar(20) NOT NULL CHECK (actor_role = 'admin'),
  action varchar(20) NOT NULL CHECK (action IN ('verify', 'revoke')),
  reason varchar(1000) NOT NULL CHECK (length(btrim(reason)) > 0),
  previous_rights_status varchar(20) NOT NULL CHECK (previous_rights_status IN ('unverified', 'verified', 'revoked')),
  new_rights_status varchar(20) NOT NULL CHECK (new_rights_status IN ('verified', 'revoked')),
  rights_basis varchar(40),
  rights_evidence_url varchar(2048),
  source_publisher varchar(255),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_media_rights_audits_asset_created_idx
  ON public.product_media_rights_audits (asset_id, created_at DESC);

CREATE INDEX IF NOT EXISTS product_media_rights_audits_product_created_idx
  ON public.product_media_rights_audits (product_id, created_at DESC);

ALTER TABLE public.product_media_rights_audits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.product_media_rights_audits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.product_media_rights_audits TO affiliateos_runtime;

DROP POLICY IF EXISTS affiliateos_runtime_select ON public.product_media_rights_audits;
DROP POLICY IF EXISTS affiliateos_runtime_insert ON public.product_media_rights_audits;
DROP POLICY IF EXISTS affiliateos_runtime_all ON public.product_media_rights_audits;
CREATE POLICY affiliateos_runtime_all
  ON public.product_media_rights_audits
  FOR ALL TO affiliateos_runtime
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.prevent_product_media_rights_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Product media rights audit records are append-only.';
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_product_media_rights_audit_mutation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS product_media_rights_audits_append_only ON public.product_media_rights_audits;
CREATE TRIGGER product_media_rights_audits_append_only
  BEFORE UPDATE OR DELETE ON public.product_media_rights_audits
  FOR EACH ROW EXECUTE FUNCTION public.prevent_product_media_rights_audit_mutation();
