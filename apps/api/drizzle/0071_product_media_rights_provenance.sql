ALTER TABLE public.product_media_assets
  ADD COLUMN IF NOT EXISTS source_publisher varchar(255),
  ADD COLUMN IF NOT EXISTS rights_status varchar(20) NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS rights_basis varchar(40),
  ADD COLUMN IF NOT EXISTS rights_evidence_url varchar(2048),
  ADD COLUMN IF NOT EXISTS rights_verified_at timestamptz;

ALTER TABLE public.product_media_assets
  ADD CONSTRAINT product_media_assets_rights_status_check
  CHECK (rights_status IN ('unverified', 'verified', 'revoked'));

ALTER TABLE public.product_media_assets
  ADD CONSTRAINT product_media_assets_rights_basis_check
  CHECK (rights_basis IS NULL OR rights_basis IN (
    'explicit_permission',
    'license',
    'public_domain',
    'user_owned',
    'platform_authorization'
  ));

ALTER TABLE public.product_media_assets
  ADD CONSTRAINT product_media_assets_verified_rights_evidence_check
  CHECK (
    rights_status <> 'verified'
    OR (
      rights_basis IS NOT NULL
      AND rights_evidence_url IS NOT NULL
      AND rights_verified_at IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS product_media_assets_rights_status_idx
  ON public.product_media_assets (rights_status, product_id);
