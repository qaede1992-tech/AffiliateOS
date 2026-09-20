CREATE TABLE IF NOT EXISTS "media_assets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "content_id" uuid NOT NULL REFERENCES "content"("id"),
  "kind" varchar(20) NOT NULL,
  "source" varchar(30) NOT NULL,
  "reference" varchar(4096) NOT NULL,
  "mime_type" varchar(100),
  "byte_size" bigint,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_content_idx" ON "media_assets" ("content_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_content_kind_idx" ON "media_assets" ("content_id", "kind");
