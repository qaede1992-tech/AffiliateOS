CREATE TABLE IF NOT EXISTS "conversion_attributions" (
  "conversion_id" uuid PRIMARY KEY REFERENCES "conversions"("id"),
  "tracking_link_id" uuid NOT NULL REFERENCES "tracking_links"("id"),
  "attributed_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "conversion_attributions_tracking_link_idx"
  ON "conversion_attributions" ("tracking_link_id", "attributed_at");
