ALTER TABLE public.product_media_candidates
  ADD COLUMN IF NOT EXISTS reviewed_by varchar(255),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_reason varchar(1000);

CREATE TABLE IF NOT EXISTS public.product_media_candidate_review_audits (
  id uuid PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES public.product_media_candidates(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  actor_id varchar(255) NOT NULL,
  actor_role varchar(20) NOT NULL CHECK (actor_role = 'admin'),
  action varchar(20) NOT NULL CHECK (action IN ('approve', 'reject')),
  reason varchar(1000) NOT NULL,
  previous_status varchar(20) NOT NULL CHECK (previous_status = 'pending'),
  new_status varchar(20) NOT NULL CHECK (new_status IN ('approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_media_candidate_review_audits_candidate_created_idx
  ON public.product_media_candidate_review_audits (candidate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_media_candidate_review_audits_product_created_idx
  ON public.product_media_candidate_review_audits (product_id, created_at DESC);

ALTER TABLE public.product_media_candidate_review_audits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.product_media_candidate_review_audits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.product_media_candidate_review_audits TO affiliateos_runtime;
DROP POLICY IF EXISTS affiliateos_runtime_access ON public.product_media_candidate_review_audits;
CREATE POLICY affiliateos_runtime_access ON public.product_media_candidate_review_audits
  FOR ALL TO affiliateos_runtime USING (true) WITH CHECK (true);

COMMENT ON TABLE public.product_media_candidate_review_audits IS
  'Immutable administrator decisions about candidate identity; this audit does not grant publication rights.';
