ALTER TABLE "content"
  ADD COLUMN IF NOT EXISTS "social_account_id" uuid REFERENCES "social_accounts"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_social_account_idx" ON "content" ("social_account_id");
