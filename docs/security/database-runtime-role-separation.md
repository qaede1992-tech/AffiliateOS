# Database runtime and migration connection separation

## Purpose

AffiliateOS currently creates its PostgreSQL pool from `DATABASE_URL`. The same variable has historically been used by Drizzle's migration CLI. In production, using a table-owner or `BYPASSRLS` role for the long-running API defeats row-level security and gives the API more authority than it needs.

This change introduces an optional `MIGRATION_DATABASE_URL` for the Drizzle CLI while keeping `DATABASE_URL` as the API runtime connection.

## Environment contract

- `DATABASE_URL`: runtime connection used by the API and read-only migration verification scripts.
- `MIGRATION_DATABASE_URL`: optional deployment-tooling connection used by Drizzle migrations. It should be supplied only to a trusted migration job, not to the long-running API process.
- If `MIGRATION_DATABASE_URL` is unset, Drizzle falls back to `DATABASE_URL` to preserve local development and existing CI behavior.
- Production preflight checks that a configured migration URL is a PostgreSQL URL and has a different database role identity from `DATABASE_URL`. It never prints either URL or its credentials.

## Safe rollout sequence

1. Keep the current production/staging behavior unchanged while preparing the new runtime role.
2. Inspect the actual SQL operations used by every repository, transaction, scheduler, event worker, publication worker, and readiness check. Build a table-by-table least-privilege grant matrix from that evidence; do not guess grants from table names alone.
3. In staging only, provision a dedicated runtime role that is not a table owner, is not a superuser, and does not have `BYPASSRLS`. Grant only the required schema usage, table DML, sequence, and routine privileges. Keep the owner/migration credential separate.
4. Add and run integration tests using the actual runtime role, including reads and writes, transactions, background workers, Shopee CSV import, media flows, and existing TikTok publication behavior. Verify denied operations are denied.
5. Configure the staging API's `DATABASE_URL` to the runtime role. Provide `MIGRATION_DATABASE_URL` only to the staging migration job. Re-run readiness and application smoke tests and check logs.
6. Only after the staging evidence is clean, schedule production credential/configuration changes with a rollback plan. Do not run a blanket RLS enablement as a substitute for role separation and tested policies.

## Important limitations

- This connection split is plumbing, not a completed least-privilege rollout. It does not create database roles, grant privileges, enable RLS, or change either Supabase project.
- The API still needs a deliberate policy decision before RLS is enabled on application tables. The current single-operator API and background workers must continue to work, but must not receive owner-level bypass privileges by default.
- Never commit database URLs, passwords, service keys, or role-creation credentials.
