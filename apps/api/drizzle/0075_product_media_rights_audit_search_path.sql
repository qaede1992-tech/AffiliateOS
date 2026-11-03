CREATE OR REPLACE FUNCTION public.prevent_product_media_rights_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Product media rights audit records are append-only.';
END;
$$;
