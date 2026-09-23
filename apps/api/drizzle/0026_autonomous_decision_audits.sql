CREATE TABLE IF NOT EXISTS "autonomous_decision_audits" (
  "id" uuid PRIMARY KEY NOT NULL,
  "cycle_id" varchar(200) NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id"),
  "marketplace_id" uuid NOT NULL REFERENCES "marketplaces"("id"),
  "selected" boolean NOT NULL,
  "score" real NOT NULL,
  "policy" jsonb NOT NULL,
  "reasons" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "autonomous_decision_audits_cycle_idx" ON "autonomous_decision_audits" USING btree ("cycle_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "autonomous_decision_audits_marketplace_created_idx" ON "autonomous_decision_audits" USING btree ("marketplace_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "autonomous_decision_audits_product_created_idx" ON "autonomous_decision_audits" USING btree ("product_id", "created_at");
