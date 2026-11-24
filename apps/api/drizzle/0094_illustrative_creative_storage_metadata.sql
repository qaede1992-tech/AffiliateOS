-- Store only a relative, opaque local-volume key for generated illustrative creatives.
-- Absolute filesystem paths remain deployment configuration and never enter the database.
ALTER TABLE public.generated_product_creatives
  ADD COLUMN IF NOT EXISTS storage_backend varchar(30),
  ADD COLUMN IF NOT EXISTS storage_key varchar(255);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'generated_product_creatives_storage_pair_check'
      AND conrelid = 'public.generated_product_creatives'::regclass
  ) THEN
    ALTER TABLE public.generated_product_creatives
      ADD CONSTRAINT generated_product_creatives_storage_pair_check CHECK (
        (storage_backend IS NULL AND storage_key IS NULL)
        OR (
          storage_backend IS NOT NULL
          AND storage_backend = 'local_volume'
          AND storage_key IS NOT NULL
          AND storage_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{64}\.mp4$'
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS generated_product_creatives_storage_key_unique
  ON public.generated_product_creatives(storage_key)
  WHERE storage_key IS NOT NULL;
