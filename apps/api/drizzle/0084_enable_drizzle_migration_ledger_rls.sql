-- The Drizzle ledger is private deployment metadata, not an application API table.
-- Keep RLS enabled without FORCE RLS. Production and Staging currently own this
-- table with the postgres role, which has BYPASSRLS and remains able to migrate it.
ALTER TABLE drizzle.__drizzle_migrations ENABLE ROW LEVEL SECURITY;
