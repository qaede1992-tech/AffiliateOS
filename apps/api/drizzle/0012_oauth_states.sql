CREATE TABLE IF NOT EXISTS "oauth_states" (
  "state" varchar(36) PRIMARY KEY NOT NULL,
  "platform" varchar(50) NOT NULL,
  "redirect_uri" varchar(2048) NOT NULL,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_states_expires_idx" ON "oauth_states" ("expires_at");
