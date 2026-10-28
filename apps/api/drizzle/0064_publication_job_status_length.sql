-- The worker persists `awaiting_confirmation` for accepted asynchronous publications.
-- That value exceeds the previous varchar(20) limit and caused retry loops after Instagram accepted a media container.
ALTER TABLE public.publication_jobs
  ALTER COLUMN status TYPE varchar(30);
