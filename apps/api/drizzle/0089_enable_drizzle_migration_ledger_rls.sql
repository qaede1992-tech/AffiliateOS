-- The Drizzle ledger is private deployment metadata, not an application API table.
-- Keep RLS enabled without FORCE RLS. The controlled migration connection must
-- use the postgres owner role (BYPASSRLS); runtime, anon, and authenticated roles
-- do not need access to this ledger.
ALTER TABLE drizzle.__drizzle_migrations ENABLE ROW LEVEL SECURITY;
