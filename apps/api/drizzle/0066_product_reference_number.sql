CREATE SEQUENCE IF NOT EXISTS public.products_reference_number_seq;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS reference_number integer;

WITH numbered_products AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC)::integer AS reference_number
  FROM public.products
)
UPDATE public.products AS product
SET reference_number = numbered_products.reference_number
FROM numbered_products
WHERE product.id = numbered_products.id
  AND product.reference_number IS NULL;

SELECT setval(
  'public.products_reference_number_seq',
  GREATEST(COALESCE((SELECT MAX(reference_number) FROM public.products), 0), 1),
  COALESCE((SELECT MAX(reference_number) FROM public.products), 0) > 0
);

ALTER TABLE public.products
  ALTER COLUMN reference_number SET DEFAULT nextval('public.products_reference_number_seq'),
  ALTER COLUMN reference_number SET NOT NULL;

ALTER SEQUENCE public.products_reference_number_seq OWNED BY public.products.reference_number;

CREATE UNIQUE INDEX IF NOT EXISTS products_reference_number_unique
  ON public.products (reference_number);
