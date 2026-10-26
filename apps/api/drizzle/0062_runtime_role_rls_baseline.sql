DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'affiliateos_runtime') THEN
    EXECUTE 'CREATE ROLE affiliateos_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;
END
$$;

-- Keep the role non-owner and unable to perform DDL or bypass RLS, even if it
-- existed before this migration. LOGIN is provisioned separately per environment.
ALTER ROLE affiliateos_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO affiliateos_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO affiliateos_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO affiliateos_runtime;

-- Future tables/sequences created by the migration owner receive only runtime
-- DML/sequence privileges; the runtime role receives no ownership or DDL rights.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO affiliateos_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO affiliateos_runtime;

-- AffiliateOS is currently a single-operator service, not a multi-tenant data
-- plane. These explicit policies permit the trusted API role to work across
-- application rows while preventing it from bypassing RLS as a table owner.
-- Row-level tenant isolation must be designed separately before multi-tenancy.
DO $$
DECLARE
  app_table record;
BEGIN
  FOR app_table IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', app_table.relname);
    EXECUTE format('DROP POLICY IF EXISTS affiliateos_runtime_access ON public.%I', app_table.relname);
    EXECUTE format(
      'CREATE POLICY affiliateos_runtime_access ON public.%I FOR ALL TO affiliateos_runtime USING (true) WITH CHECK (true)',
      app_table.relname
    );
  END LOOP;
END
$$;
