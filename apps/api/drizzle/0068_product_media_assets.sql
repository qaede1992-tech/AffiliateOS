CREATE TABLE IF NOT EXISTS public.product_media_assets (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  kind varchar(10) NOT NULL CHECK (kind IN ('image', 'video')),
  bucket varchar(100) NOT NULL,
  object_key varchar(1024) NOT NULL,
  mime_type varchar(50) NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'video/mp4')),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  source_url varchar(2048) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_media_assets_product_hash_unique UNIQUE (product_id, sha256),
  CONSTRAINT product_media_assets_bucket_key_unique UNIQUE (bucket, object_key)
);

CREATE INDEX IF NOT EXISTS product_media_assets_product_kind_idx
  ON public.product_media_assets (product_id, kind, created_at DESC);

ALTER TABLE public.product_media_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.product_media_assets FROM PUBLIC, anon, authenticated;
