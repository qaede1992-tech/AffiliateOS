CREATE TABLE IF NOT EXISTS "publication_operations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "content_id" uuid NOT NULL REFERENCES "content"("id"),
  "job_id" uuid NOT NULL REFERENCES "publication_jobs"("id"),
  "provider" varchar(100) NOT NULL,
  "provider_operation_id" varchar(500) NOT NULL,
  "status" varchar(20) NOT NULL,
  "external_post_id" varchar(500),
  "last_error" varchar(2000),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "publication_operations_provider_operation_unique" UNIQUE ("provider", "provider_operation_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publication_operations_content_idx" ON "publication_operations" ("content_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publication_operations_status_idx" ON "publication_operations" ("status");
