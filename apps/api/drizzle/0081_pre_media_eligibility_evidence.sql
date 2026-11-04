-- Preserve preliminary product eligibility independently from final publication decisions.
-- These records authorize only the admin-reviewed media import workflow; they are
-- not final selections, campaign outcomes, or publication-rights evidence.
CREATE TABLE IF NOT EXISTS public.pre_media_eligibility_evidence (
  id uuid PRIMARY KEY,
  cycle_id varchar(240) NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  marketplace_id uuid NOT NULL REFERENCES public.marketplaces(id) ON DELETE CASCADE,
  offer_id uuid REFERENCES public.affiliate_offers(id) ON DELETE SET NULL,
  eligible boolean NOT NULL,
  score real NOT NULL CHECK (score >= 0 AND score <= 100),
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pre_media_eligibility_product_created_idx
  ON public.pre_media_eligibility_evidence (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pre_media_eligibility_cycle_idx
  ON public.pre_media_eligibility_evidence (cycle_id);

ALTER TABLE public.pre_media_eligibility_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pre_media_eligibility_evidence FROM PUBLIC, anon, authenticated;
-- 0062 grants default DML to the runtime role; explicitly make this evidence append-only.
REVOKE UPDATE, DELETE ON TABLE public.pre_media_eligibility_evidence FROM affiliateos_runtime;
GRANT SELECT, INSERT ON TABLE public.pre_media_eligibility_evidence TO affiliateos_runtime;
DROP POLICY IF EXISTS affiliateos_runtime_access ON public.pre_media_eligibility_evidence;
CREATE POLICY affiliateos_runtime_access ON public.pre_media_eligibility_evidence
  FOR ALL TO affiliateos_runtime USING (true) WITH CHECK (true);
