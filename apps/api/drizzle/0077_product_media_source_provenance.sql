ALTER TABLE public.product_media_assets
  ADD COLUMN IF NOT EXISTS source_provider varchar(40),
  ADD COLUMN IF NOT EXISTS source_candidate_id uuid,
  ADD COLUMN IF NOT EXISTS source_landing_page_url varchar(2048),
  ADD COLUMN IF NOT EXISTS source_title varchar(1000),
  ADD COLUMN IF NOT EXISTS source_query varchar(500),
  ADD COLUMN IF NOT EXISTS source_creator varchar(500),
  ADD COLUMN IF NOT EXISTS source_creator_url varchar(2048),
  ADD COLUMN IF NOT EXISTS source_license varchar(40),
  ADD COLUMN IF NOT EXISTS source_license_version varchar(40),
  ADD COLUMN IF NOT EXISTS source_license_url varchar(2048);

COMMENT ON COLUMN public.product_media_assets.source_candidate_id IS
  'Optional link to the reviewed discovery candidate; rights remain independently unverified.';
