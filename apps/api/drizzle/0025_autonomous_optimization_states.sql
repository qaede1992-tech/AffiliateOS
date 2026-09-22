CREATE TABLE IF NOT EXISTS "autonomous_optimization_states" (
  "campaign_id" uuid PRIMARY KEY NOT NULL REFERENCES "campaigns"("id"),
  "action" varchar(20) NOT NULL,
  "applied_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "autonomous_optimization_states_updated_idx" ON "autonomous_optimization_states" USING btree ("updated_at");
