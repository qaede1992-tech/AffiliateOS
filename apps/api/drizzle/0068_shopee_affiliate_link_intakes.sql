CREATE TABLE IF NOT EXISTS public.shopee_affiliate_link_intakes (
  id uuid PRIMARY KEY,
  marketplace_slug varchar(100) NOT NULL DEFAULT 'shopee-affiliate-feed',
  affiliate_url varchar(2048) NOT NULL,
  normalized_url_hash varchar(64) NOT NULL CHECK (normalized_url_hash ~ '^[0-9a-f]{64}$'),
  canonical_product_url varchar(2048),
  shop_id varchar(32),
  item_id varchar(32),
  status varchar(30) NOT NULL DEFAULT 'received' CHECK (status IN ('received','resolving','resolved','awaiting_offer_data','ready_for_catalog','imported','unresolved','failed')),
  reason varchar(1000),
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopee_link_intakes_identity_pair_check CHECK ((shop_id IS NULL) = (item_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS shopee_link_intakes_url_hash_unique ON public.shopee_affiliate_link_intakes (normalized_url_hash);
CREATE UNIQUE INDEX IF NOT EXISTS shopee_link_intakes_product_identity_unique ON public.shopee_affiliate_link_intakes (marketplace_slug, shop_id, item_id) WHERE shop_id IS NOT NULL AND item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shopee_link_intakes_status_updated_idx ON public.shopee_affiliate_link_intakes (status, updated_at DESC);
ALTER TABLE public.shopee_affiliate_link_intakes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shopee_affiliate_link_intakes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shopee_affiliate_link_intakes TO affiliateos_runtime;
DROP POLICY IF EXISTS affiliateos_runtime_access ON public.shopee_affiliate_link_intakes;
CREATE POLICY affiliateos_runtime_access ON public.shopee_affiliate_link_intakes FOR ALL TO affiliateos_runtime USING (true) WITH CHECK (true);
