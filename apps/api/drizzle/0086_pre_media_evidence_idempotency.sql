-- Prevent repeated autonomous cycles from storing identical pre-media eligibility decisions.
-- Existing rows remain untouched; new rows receive a deterministic fingerprint.
ALTER TABLE public.pre_media_eligibility_evidence
  ADD COLUMN IF NOT EXISTS fingerprint varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS pre_media_eligibility_fingerprint_unique
  ON public.pre_media_eligibility_evidence (fingerprint)
  WHERE fingerprint IS NOT NULL;
