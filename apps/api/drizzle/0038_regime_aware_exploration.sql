ALTER TABLE "autonomous_decision_audits" ADD COLUMN IF NOT EXISTS "performance_regime" varchar(20);
ALTER TABLE "autonomous_exploration_states" ADD COLUMN IF NOT EXISTS "rising_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "autonomous_exploration_states" ADD COLUMN IF NOT EXISTS "stable_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "autonomous_exploration_states" ADD COLUMN IF NOT EXISTS "declining_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "autonomous_exploration_states" ADD COLUMN IF NOT EXISTS "volatile_count" integer NOT NULL DEFAULT 0;
