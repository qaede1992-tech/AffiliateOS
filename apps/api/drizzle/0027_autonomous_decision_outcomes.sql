ALTER TABLE "autonomous_decision_audits"
  ADD COLUMN "outcome_offer_id" uuid REFERENCES "affiliate_offers"("id"),
  ADD COLUMN "outcome_status" varchar(20),
  ADD COLUMN "outcome_campaign_id" uuid REFERENCES "campaigns"("id"),
  ADD COLUMN "outcome_error" varchar(2000),
  ADD COLUMN "outcome_observed_at" timestamptz;

CREATE INDEX "autonomous_decision_audits_outcome_status_idx"
  ON "autonomous_decision_audits" ("outcome_status", "outcome_observed_at");