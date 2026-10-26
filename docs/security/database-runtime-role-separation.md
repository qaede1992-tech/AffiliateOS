# Database runtime and migration connection separation

## Purpose

AffiliateOS currently creates its PostgreSQL pool from `DATABASE_URL`. The same variable has historically been used by Drizzle's migration CLI. In production, using a table-owner or `BYPASSRLS` role for the long-running API defeats row-level security and gives the API more authority than it needs.

This change introduces an optional `MIGRATION_DATABASE_URL` for the Drizzle CLI while keeping `DATABASE_URL` as the API runtime connection.

## Environment contract

- `DATABASE_URL`: runtime connection used by the API and read-only migration verification scripts.
- `MIGRATION_DATABASE_URL`: optional deployment-tooling connection used by Drizzle migrations. It should be supplied only to a trusted migration job, not to the long-running API process.
- If `MIGRATION_DATABASE_URL` is unset, Drizzle falls back to `DATABASE_URL` to preserve local development and existing CI behavior.
- Production preflight checks that a configured migration URL is a PostgreSQL URL and has a different database role identity from `DATABASE_URL`. It never prints either URL or its credentials.

## Runtime-role migration and policy model

Migration `0062_runtime_role_rls_baseline.sql` provisions the `affiliateos_runtime` role as `NOLOGIN`, removes superuser/database-creation/role-creation/BYPASSRLS privileges, grants only DML and sequence permissions, configures default DML grants for future objects created by the migration owner, and enables RLS on all current public application tables.

The policy `affiliateos_runtime_access` permits all rows for this one trusted backend role. That matches the current single-operator application model; it is **not** tenant isolation. The role remains `NOLOGIN` until a separate environment-specific credential provisioning step is performed. No password or login credential is stored in migration SQL.

## Safe rollout sequence

1. Keep current staging/production API connections unchanged while the migration is reviewed and tested in CI.
2. Apply the migration to staging through the project's Drizzle migration process, using the dedicated migration connection. Confirm all 29 public application tables have RLS enabled and an explicit policy for `affiliateos_runtime`.
3. Provision a strong environment-specific password outside source control and enable LOGIN for `affiliateos_runtime` through a trusted database administration path. Never put a password in a migration, issue, commit, or log.
4. Set the staging API's `DATABASE_URL` to the runtime role and keep `MIGRATION_DATABASE_URL` restricted to the trusted migration job. Re-run readiness and application smoke tests.
5. Exercise authenticated CRUD, transactions, provider-event processing, autonomous workers, Shopee CSV import, media flows, and the existing TikTok publication flow using the actual runtime role. Verify that DDL, TRUNCATE, TRIGGER, and role-management privileges remain denied.
6. Only after staging evidence is clean, schedule production migration and credential/configuration changes with a rollback plan. Do not enable production runtime credentials before the staging checks pass.

## Important limitations

- This connection split is plumbing, not a completed least-privilege rollout. It does not create database roles, grant privileges, enable RLS, or change either Supabase project.
- The API still needs a deliberate policy decision before RLS is enabled on application tables. The current single-operator API and background workers must continue to work, but must not receive owner-level bypass privileges by default.
- Never commit database URLs, passwords, service keys, or role-creation credentials.
