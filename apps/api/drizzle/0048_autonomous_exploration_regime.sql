ALTER TABLE "autonomous_exploration_states" ADD COLUMN IF NOT EXISTS "regime_rising_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "autonomous_exploration_states" ADD COLUMN IF NOT EXISTS "regime_stable_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "autonomous_exploration_states" ADD COLUMN IF NOT EXISTS "regime_declining_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "autonomous_exploration_states" ADD COLUMN IF NOT EXISTS "regime_volatile_count" integer NOT NULL DEFAULT 0;
