-- Reconcile link-table keys without assuming every target has identical drift.
-- The clean schema or a previously repaired database may already have the
-- desired primary key. Refuse to replace an unrelated primary key silently.
DO $$
DECLARE
  existing_pk_columns text[];
BEGIN
  SELECT array_agg(a.attname ORDER BY k.ordinality)
    INTO existing_pk_columns
  FROM pg_constraint c
  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.conrelid = 'public.campaign_offers'::regclass
    AND c.contype = 'p';

  IF existing_pk_columns IS NULL THEN
    ALTER TABLE public.campaign_offers
      ADD CONSTRAINT campaign_offers_pkey
      PRIMARY KEY (campaign_id, affiliate_offer_id);
  ELSIF existing_pk_columns <> ARRAY['campaign_id', 'affiliate_offer_id']::text[] THEN
    RAISE EXCEPTION 'campaign_offers already has an unexpected primary key: %', existing_pk_columns;
  END IF;
END $$;

-- The primary key enforces this pair's uniqueness; remove the redundant index
-- if the older Drizzle schema created it separately.
DROP INDEX IF EXISTS public.campaign_offers_unique;

DO $$
DECLARE
  existing_pk_columns text[];
BEGIN
  SELECT array_agg(a.attname ORDER BY k.ordinality)
    INTO existing_pk_columns
  FROM pg_constraint c
  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.conrelid = 'public.content_products'::regclass
    AND c.contype = 'p';

  IF existing_pk_columns IS NULL THEN
    ALTER TABLE public.content_products
      ADD CONSTRAINT content_products_pkey
      PRIMARY KEY (content_id, product_id);
  ELSIF existing_pk_columns <> ARRAY['content_id', 'product_id']::text[] THEN
    RAISE EXCEPTION 'content_products already has an unexpected primary key: %', existing_pk_columns;
  END IF;
END $$;

-- Remove the former unique constraint if present; the composite primary key
-- now provides the same uniqueness guarantee.
ALTER TABLE public.content_products
  DROP CONSTRAINT IF EXISTS content_products_content_product_unique;
