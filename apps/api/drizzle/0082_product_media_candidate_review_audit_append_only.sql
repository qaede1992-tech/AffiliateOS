-- The candidate review audit table was created after the runtime role's default DML grants.
-- Keep administrator decisions append-only for the application runtime role.
REVOKE UPDATE, DELETE ON TABLE public.product_media_candidate_review_audits FROM affiliateos_runtime;
