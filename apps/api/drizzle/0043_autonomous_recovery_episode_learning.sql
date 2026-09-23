ALTER TABLE "autonomous_feedback_snapshots" ADD COLUMN IF NOT EXISTS "recovery_episode_id" uuid;
ALTER TABLE "autonomous_action_outcomes" ADD COLUMN IF NOT EXISTS "recovery_episode_id" uuid;
