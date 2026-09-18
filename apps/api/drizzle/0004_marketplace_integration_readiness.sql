-- Connection readiness metadata only. Secret values remain outside PostgreSQL.
ALTER TABLE "marketplaces" ADD COLUMN IF NOT EXISTS "connection_mode" varchar(20) NOT NULL DEFAULT 'official_api';
ALTER TABLE "marketplaces" ADD COLUMN IF NOT EXISTS "enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "marketplaces" ADD COLUMN IF NOT EXISTS "health_status" varchar(20) NOT NULL DEFAULT 'unverified';
ALTER TABLE "marketplaces" ADD COLUMN IF NOT EXISTS "health_error" varchar(500);
ALTER TABLE "marketplaces" ADD COLUMN IF NOT EXISTS "health_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "marketplaces" ADD COLUMN IF NOT EXISTS "last_checked_at" timestamp with time zone;
ALTER TABLE "marketplaces" ADD COLUMN IF NOT EXISTS "last_successful_check_at" timestamp with time zone;
ALTER TABLE "marketplaces" ADD COLUMN IF NOT EXISTS "last_successful_sync_at" timestamp with time zone;
