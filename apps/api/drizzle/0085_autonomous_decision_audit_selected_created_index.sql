-- Support selected/unselected audit filtering with newest-first pagination.
-- The composite index avoids sorting the full audit history for filtered list calls.
CREATE INDEX IF NOT EXISTS autonomous_decision_audits_selected_created_idx
  ON public.autonomous_decision_audits (selected, created_at DESC);
