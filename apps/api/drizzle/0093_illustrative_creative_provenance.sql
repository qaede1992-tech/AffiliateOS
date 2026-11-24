-- Separate AffiliateOS-generated creative provenance from third-party product-media rights.
-- This migration is additive. No policy is enabled and no creative is publishable by default.

CREATE TABLE public.illustrative_creative_policies (
  platform varchar(30) PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  policy_version varchar(40) NOT NULL,
  approved_by varchar(255),
  approved_at timestamptz,
  terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT illustrative_creative_policies_platform_check CHECK (platform IN ('instagram')),
  CONSTRAINT illustrative_creative_policies_activation_check CHECK (NOT enabled OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE public.generated_product_creatives (
  id uuid PRIMARY KEY,
  media_asset_id uuid NOT NULL UNIQUE REFERENCES public.media_assets(id) ON DELETE RESTRICT,
  content_id uuid NOT NULL REFERENCES public.content(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  affiliate_offer_id uuid REFERENCES public.affiliate_offers(id) ON DELETE RESTRICT,
  platform varchar(30) NOT NULL,
  renderer_version varchar(40) NOT NULL,
  template_version varchar(40) NOT NULL,
  sha256 varchar(64) NOT NULL,
  product_snapshot jsonb NOT NULL,
  disclosure_embedded boolean NOT NULL DEFAULT false,
  mime_type varchar(100) NOT NULL,
  byte_size bigint NOT NULL,
  width_px integer NOT NULL,
  height_px integer NOT NULL,
  duration_ms integer NOT NULL,
  review_status varchar(20) NOT NULL DEFAULT 'pending',
  reviewed_by varchar(255),
  reviewed_at timestamptz,
  review_reason varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generated_product_creatives_platform_check CHECK (platform IN ('instagram')),
  CONSTRAINT generated_product_creatives_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT generated_product_creatives_dimensions_check CHECK (width_px > 0 AND height_px > 0 AND duration_ms > 0 AND byte_size > 0),
  CONSTRAINT generated_product_creatives_disclosure_check CHECK (disclosure_embedded = true),
  CONSTRAINT generated_product_creatives_review_check CHECK (
    (review_status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_status IN ('approved', 'rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_reason IS NOT NULL)
  )
);
CREATE INDEX generated_product_creatives_product_status_idx ON public.generated_product_creatives(product_id, review_status, created_at DESC);
CREATE INDEX generated_product_creatives_content_idx ON public.generated_product_creatives(content_id);

CREATE TABLE public.generated_product_creative_review_audits (
  id uuid PRIMARY KEY,
  creative_id uuid NOT NULL REFERENCES public.generated_product_creatives(id) ON DELETE RESTRICT,
  actor_id varchar(255) NOT NULL,
  actor_role varchar(20) NOT NULL,
  action varchar(20) NOT NULL CHECK (action IN ('approve', 'reject')),
  reason varchar(1000) NOT NULL,
  previous_status varchar(20) NOT NULL,
  new_status varchar(20) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generated_product_creative_review_audits_creative_created_idx
  ON public.generated_product_creative_review_audits(creative_id, created_at DESC);

CREATE TABLE public.illustrative_creative_policy_audits (
  id uuid PRIMARY KEY,
  platform varchar(30) NOT NULL CHECK (platform IN ('instagram')),
  actor_id varchar(255) NOT NULL,
  action varchar(20) NOT NULL CHECK (action IN ('enable', 'disable')),
  policy_version varchar(40) NOT NULL,
  reason varchar(1000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX illustrative_creative_policy_audits_platform_created_idx
  ON public.illustrative_creative_policy_audits(platform, created_at DESC);

-- Runtime has DML grants from the existing default privileges, but new tables
-- must opt into the same RLS policy explicitly. No anon/authenticated policy.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'illustrative_creative_policies',
    'generated_product_creatives',
    'generated_product_creative_review_audits',
    'illustrative_creative_policy_audits'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY affiliateos_runtime_access ON public.%I FOR ALL TO affiliateos_runtime USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END $$;

-- Review and policy audit rows are append-only, even for the runtime role.
CREATE FUNCTION public.reject_illustrative_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Illustrative creative audit records are immutable';
END;
$$;
CREATE TRIGGER generated_product_creative_review_audits_immutable
  BEFORE UPDATE OR DELETE ON public.generated_product_creative_review_audits
  FOR EACH ROW EXECUTE FUNCTION public.reject_illustrative_audit_mutation();
CREATE TRIGGER illustrative_creative_policy_audits_immutable
  BEFORE UPDATE OR DELETE ON public.illustrative_creative_policy_audits
  FOR EACH ROW EXECUTE FUNCTION public.reject_illustrative_audit_mutation();

-- No seed row: publication policy remains disabled until an explicit admin action.
