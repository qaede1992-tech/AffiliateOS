-- Marketplace Engine is additive: no credentials are stored here, only opaque secret-manager references.
ALTER TABLE "marketplaces" ADD COLUMN IF NOT EXISTS "provider_slug" varchar(100);
ALTER TABLE "marketplaces" ADD COLUMN IF NOT EXISTS "credential_reference" varchar(255);
UPDATE "marketplaces" SET "provider_slug" = "unconfigured" WHERE "provider_slug" IS NULL;
ALTER TABLE "marketplaces" ALTER COLUMN "provider_slug" SET NOT NULL;

ALTER TABLE "affiliate_offers" ALTER COLUMN "affiliate_url" DROP NOT NULL;
ALTER TABLE "affiliate_offers" ADD COLUMN IF NOT EXISTS "price_cents" bigint;
ALTER TABLE "affiliate_offers" ADD COLUMN IF NOT EXISTS "currency" varchar(3);
ALTER TABLE "affiliate_offers" ADD COLUMN IF NOT EXISTS "availability" varchar(20) NOT NULL DEFAULT 'unknown';
ALTER TABLE "affiliate_offers" ADD COLUMN IF NOT EXISTS "availability_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "affiliate_offers" ADD COLUMN IF NOT EXISTS "affiliate_link_status" varchar(20) NOT NULL DEFAULT 'not_generated';
