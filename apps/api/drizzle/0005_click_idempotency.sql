ALTER TABLE "clicks" ADD COLUMN IF NOT EXISTS "idempotency_key" varchar(200);
CREATE UNIQUE INDEX IF NOT EXISTS "clicks_link_idempotency_unique" ON "clicks" ("tracking_link_id", "idempotency_key");
