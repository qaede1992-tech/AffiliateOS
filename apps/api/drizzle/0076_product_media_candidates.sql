CREATE TABLE IF NOT EXISTS public.product_media_candidates (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  provider varchar(40) NOT NULL,
  candidate_hash varchar(64) NOT NULL CHECK (candidate_hash ~ '^[0-9a-f]{64}$'),
  query varchar(500) NOT NULL,
  title varchar(1000) NOT NULL,
  image_url varchar(2048) NOT NULL,
  landing_page_url varchar(2048) NOT NULL,
  creator varchar(500),
  creator_url varchar(2048),
  license varchar(40),
  license_version varchar(40),
  license_url varchar(2048),
  source_publisher varchar(255),
  identity_score integer NOT NULL CHECK (identity_score BETWEEN 0 AND 100),
  identity_status varchar(30) NOT NULL CHECK (identity_status IN ('strong_match', 'review_required')),
  identity_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_status varchar(20) NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  rights_status varchar(20) NOT NULL DEFAULT 'unverified' CHECK (rights_status IN ('unverified', 'verified', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_media_candidates_product_provider_hash_unique UNIQUE (product_id, provider, candidate_hash)
);

CREATE INDEX IF NOT EXISTS product_media_candidates_product_review_idx
  ON public.product_media_candidates (product_id, review_status, created_at DESC);

ALTER TABLE public.product_media_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.product_media_candidates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_media_candidates TO affiliateos_runtime;
DROP POLICY IF EXISTS affiliateos_runtime_access ON public.product_media_candidates;
CREATE POLICY affiliateos_runtime_access ON public.product_media_candidates
  FOR ALL TO affiliateos_runtime USING (true) WITH CHECK (true);
