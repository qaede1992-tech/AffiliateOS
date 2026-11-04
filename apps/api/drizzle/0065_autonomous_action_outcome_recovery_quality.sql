-- Match the Drizzle schema: autonomous action outcomes persist recovery quality scores.
-- Existing rows receive the neutral default; no existing data is removed or rewritten.
ALTER TABLE "autonomous_action_outcomes"
  ADD COLUMN IF NOT EXISTS "recovery_quality_score" real NOT NULL DEFAULT 0;
