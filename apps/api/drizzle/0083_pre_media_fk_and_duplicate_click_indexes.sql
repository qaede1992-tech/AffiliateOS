-- Add covering indexes for the preliminary eligibility evidence foreign keys.
-- Keep the product/cycle indexes because they serve separate lookup paths.
CREATE INDEX IF NOT EXISTS pre_media_eligibility_marketplace_idx
  ON public.pre_media_eligibility_evidence (marketplace_id);
CREATE INDEX IF NOT EXISTS pre_media_eligibility_offer_idx
  ON public.pre_media_eligibility_evidence (offer_id);

-- These legacy names duplicate the canonical indexes created by migration 0023.
-- They are not constraint-backed; retain the canonical indexes used by current code.
DROP INDEX IF EXISTS public.clicks_link_occurred_idx;
DROP INDEX IF EXISTS public.clicks_link_idempotency_unique;
