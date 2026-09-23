ALTER TABLE "autonomous_action_outcomes" ADD COLUMN IF NOT EXISTS "recovery_state" varchar(12) NOT NULL DEFAULT 'none';
ALTER TABLE "autonomous_action_outcomes" ADD COLUMN IF NOT EXISTS "recovery_evidence_score" real NOT NULL DEFAULT 0;
