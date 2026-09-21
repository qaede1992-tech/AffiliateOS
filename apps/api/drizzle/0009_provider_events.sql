CREATE TABLE IF NOT EXISTS "provider_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "affiliate_account_id" uuid NOT NULL,
  "external_event_id" varchar(255) NOT NULL,
  "event_type" varchar(100) NOT NULL,
  "payload" jsonb NOT NULL,
  "signature_version" varchar(20),
  "status" varchar(20) NOT NULL DEFAULT 'received',
  "received_at" timestamp with time zone NOT NULL,
  "processed_at" timestamp with time zone,
  "error" varchar(1000)
);
--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_affiliate_account_id_affiliate_accounts_id_fk" FOREIGN KEY ("affiliate_account_id") REFERENCES "public"."affiliate_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_events_account_external_unique" ON "provider_events" ("affiliate_account_id", "external_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_events_status_received_idx" ON "provider_events" ("status", "received_at");
