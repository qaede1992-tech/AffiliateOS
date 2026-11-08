ALTER TABLE public.product_media_assets
  ADD COLUMN IF NOT EXISTS identity_status varchar(20) NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS identity_reviewed_by varchar(255),
  ADD COLUMN IF NOT EXISTS identity_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS identity_review_reason varchar(1000);
--> statement-breakpoint

ALTER TABLE public.product_media_assets
  DROP CONSTRAINT IF EXISTS product_media_assets_identity_status_check;
--> statement-breakpoint
ALTER TABLE public.product_media_assets
  ADD CONSTRAINT product_media_assets_identity_status_check
  CHECK (identity_status IN ('not_required', 'pending', 'verified', 'rejected'));
--> statement-breakpoint
ALTER TABLE public.product_media_assets
  DROP CONSTRAINT IF EXISTS product_media_assets_identity_review_evidence_check;
--> statement-breakpoint
ALTER TABLE public.product_media_assets
  ADD CONSTRAINT product_media_assets_identity_review_evidence_check
  CHECK (
    (identity_status IN ('not_required', 'pending')
      AND identity_reviewed_by IS NULL
      AND identity_reviewed_at IS NULL
      AND identity_review_reason IS NULL)
    OR
    (identity_status IN ('verified', 'rejected')
      AND identity_reviewed_by IS NOT NULL
      AND length(btrim(identity_reviewed_by)) > 0
      AND identity_reviewed_at IS NOT NULL
      AND identity_review_reason IS NOT NULL
      AND length(btrim(identity_review_reason)) > 0)
  );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS product_media_assets_identity_status_idx
  ON public.product_media_assets (identity_status, product_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.product_media_identity_audits (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES public.product_media_assets(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  actor_id varchar(255) NOT NULL,
  actor_role varchar(20) NOT NULL CHECK (actor_role = 'admin'),
  action varchar(20) NOT NULL CHECK (action IN ('verify', 'reject')),
  reason varchar(1000) NOT NULL CHECK (length(btrim(reason)) > 0),
  previous_identity_status varchar(20) NOT NULL CHECK (previous_identity_status IN ('not_required', 'pending', 'verified', 'rejected')),
  new_identity_status varchar(20) NOT NULL CHECK (new_identity_status IN ('verified', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS product_media_identity_audits_asset_created_idx
  ON public.product_media_identity_audits (asset_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_media_identity_audits_product_created_idx
  ON public.product_media_identity_audits (product_id, created_at DESC);
--> statement-breakpoint

ALTER TABLE public.product_media_identity_audits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.product_media_identity_audits FROM PUBLIC, anon, authenticated, affiliateos_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.product_media_identity_audits TO affiliateos_runtime;
--> statement-breakpoint
DROP POLICY IF EXISTS affiliateos_runtime_all ON public.product_media_identity_audits;
--> statement-breakpoint
CREATE POLICY affiliateos_runtime_all
  ON public.product_media_identity_audits
  FOR ALL TO affiliateos_runtime
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE public.product_media_identity_audits FROM affiliateos_runtime;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.prevent_product_media_identity_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS 'BEGIN
  RAISE EXCEPTION ''Product media identity audit records are append-only.'';
END;';
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prevent_product_media_identity_audit_mutation() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS product_media_identity_audits_append_only ON public.product_media_identity_audits;
--> statement-breakpoint
CREATE TRIGGER product_media_identity_audits_append_only
  BEFORE UPDATE OR DELETE ON public.product_media_identity_audits
  FOR EACH ROW EXECUTE FUNCTION public.prevent_product_media_identity_audit_mutation();
