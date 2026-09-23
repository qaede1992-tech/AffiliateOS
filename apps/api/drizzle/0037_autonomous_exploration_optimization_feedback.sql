ALTER TABLE "autonomous_exploration_states" ADD COLUMN IF NOT EXISTS "optimization_positive_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "autonomous_exploration_states" ADD COLUMN IF NOT EXISTS "optimization_negative_count" integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS "autonomous_exploration_optimization_events" (
  "id" uuid PRIMARY KEY,
  "state_id" uuid NOT NULL REFERENCES "autonomous_exploration_states"("id"),
  "action_outcome_id" uuid NOT NULL REFERENCES "autonomous_action_outcomes"("id"),
  "signal" varchar(20) NOT NULL,
  "created_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "autonomous_exploration_optimization_events_state_outcome_unique" ON "autonomous_exploration_optimization_events" ("state_id","action_outcome_id");
CREATE INDEX IF NOT EXISTS "autonomous_exploration_optimization_events_outcome_idx" ON "autonomous_exploration_optimization_events" ("action_outcome_id");