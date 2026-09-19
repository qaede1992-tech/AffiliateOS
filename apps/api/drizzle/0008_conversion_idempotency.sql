ALTER TABLE "conversions" ADD COLUMN IF NOT EXISTS "idempotency_key" varchar(200);
CREATE UNIQUE INDEX IF NOT EXISTS "conversions_idempotency_unique" ON "conversions" ("idempotency_key");
