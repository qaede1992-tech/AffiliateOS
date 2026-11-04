-- Cover foreign-key lookups reported by the Supabase database advisor.
-- These indexes do not remove or alter existing indexes or constraints.
CREATE INDEX IF NOT EXISTS autonomous_decision_audits_outcome_campaign_id_idx
  ON public.autonomous_decision_audits (outcome_campaign_id);
CREATE INDEX IF NOT EXISTS autonomous_decision_audits_outcome_offer_id_idx
  ON public.autonomous_decision_audits (outcome_offer_id);
CREATE INDEX IF NOT EXISTS autonomous_runs_campaign_id_idx
  ON public.autonomous_runs (campaign_id);
CREATE INDEX IF NOT EXISTS autonomous_runs_offer_id_idx
  ON public.autonomous_runs (offer_id);
CREATE INDEX IF NOT EXISTS campaign_offers_affiliate_offer_id_idx
  ON public.campaign_offers (affiliate_offer_id);
CREATE INDEX IF NOT EXISTS content_product_id_idx
  ON public.content (product_id);
CREATE INDEX IF NOT EXISTS publication_jobs_content_id_idx
  ON public.publication_jobs (content_id);
CREATE INDEX IF NOT EXISTS publication_operations_job_id_idx
  ON public.publication_operations (job_id);
CREATE INDEX IF NOT EXISTS tracking_links_affiliate_offer_id_idx
  ON public.tracking_links (affiliate_offer_id);
