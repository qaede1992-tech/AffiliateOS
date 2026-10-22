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

-- The primary key enforces this pair's uniqueness. Older databases may have
-- created campaign_offers_unique as either a standalone index or a
-- constraint-backed unique index, so remove it according to its ownership.
DO $
DECLARE
  unique_index_oid oid;
  owning_constraint_name text;
BEGIN
  SELECT idx.oid
    INTO unique_index_oid
  FROM pg_class idx
  JOIN pg_namespace ns ON ns.oid = idx.relnamespace
  WHERE ns.nspname = 'public'
    AND idx.relname = 'campaign_offers_unique'
    AND idx.relkind = 'i';

  IF unique_index_oid IS NOT NULL THEN
    SELECT c.conname
      INTO owning_constraint_name
    FROM pg_constraint c
    WHERE c.conindid = unique_index_oid
      AND c.contype = 'u'
      AND c.conrelid = 'public.campaign_offers'::regclass;

    IF owning_constraint_name IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE public.campaign_offers DROP CONSTRAINT %I',
        owning_constraint_name
      );
    ELSE
      DROP INDEX public.campaign_offers_unique;
    END IF;
  END IF;
END $;

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
