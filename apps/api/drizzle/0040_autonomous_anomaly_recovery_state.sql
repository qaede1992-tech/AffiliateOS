ALTER TABLE "autonomous_feedback_snapshots" ADD COLUMN IF NOT EXISTS "recovery_state" varchar(12) NOT NULL DEFAULT 'none';
ALTER TABLE "autonomous_feedback_snapshots" ADD COLUMN IF NOT EXISTS "recovery_clicks" integer NOT NULL DEFAULT 0;
ALTER TABLE "autonomous_feedback_snapshots" ADD COLUMN IF NOT EXISTS "recovery_evidence_score" real NOT NULL DEFAULT 0;
