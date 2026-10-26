DO $$
DECLARE
  role_state record;
BEGIN
  SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolinherit, rolbypassrls
    INTO role_state
    FROM pg_roles
    WHERE rolname = 'affiliateos_runtime';

  IF NOT FOUND THEN
    -- Unspecified privileged attributes default to false in PostgreSQL.
    -- LOGIN stays disabled until a separate environment-specific step.
    EXECUTE 'CREATE ROLE affiliateos_runtime NOLOGIN NOINHERIT';
  ELSIF role_state.rolsuper OR role_state.rolcreatedb OR role_state.rolcreaterole
     OR role_state.rolcanlogin OR role_state.rolinherit OR role_state.rolbypassrls THEN
    RAISE EXCEPTION 'affiliateos_runtime exists with unsafe attributes; provision it separately before applying this migration';
  END IF;
END
$$;

-- The role is deliberately NOLOGIN until an environment-specific credential is provisioned.
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
