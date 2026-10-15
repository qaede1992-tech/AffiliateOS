# Production database migration runbook

This runbook is for an authorized operator applying AffiliateOS Drizzle migrations to the production PostgreSQL database. It does not authorize changing the database endpoint, role grants, RLS policies, or application deployment configuration.

## Current known blocker (audited 2026-10-15)

The production database audit found 53 Drizzle ledger rows and did not find:
- `publication_jobs.tiktok_approval` (migration `0056_tiktok_publication_approval_and_media_duration`)
- `media_assets.duration_seconds` (migration `0056_tiktok_publication_approval_and_media_duration`)
- `content_products` (migration `0057_content_products_multi_product_story`)

Treat these as a preflight finding until rechecked immediately before the change. Do not assume the production database is current merely because the API and web health endpoints return 200.

## Required safeguards

1. Schedule a maintenance window and identify the person authorized to approve production database changes.
2. Confirm a recent, restorable Supabase backup/PITR recovery point and the recovery owner before applying DDL.
3. Confirm the target is the AffiliateOS production project and its existing Supabase Pooler endpoint. Do not switch to Direct Connection as part of this procedure.
4. Confirm the deployed API version and the release commit whose migrations will be applied.
5. Keep the database URL in the approved secret store or the operator's protected local environment. Never paste it into issues, PR comments, chat, shell transcripts, or logs.
6. Do not use the Supabase SQL editor to run the Drizzle migration SQL manually. The Drizzle migrator must update both schema and its migration ledger.
7. Do not enable RLS across all tables or modify application-role grants as a side effect of this migration window.

## Operator procedure

Run from a trusted, clean checkout of the exact approved release commit, using Node.js 24 and the repository lockfile. Use a protected environment file or injected environment variable for `DATABASE_URL`; do not commit it.

1. Review the exact migration diff and journal entries for `0056` and `0057`. Confirm no unrelated migration is being introduced.
2. Run `npm ci`.
3. Run `npm run db:check` and stop if migration journal validation fails.
4. Run a read-only preflight against the target: verify database identity, current ledger count, and presence/absence of the three schema objects listed above. Stop if the target is ambiguous or unexpected.
5. With explicit production approval, run `npm run db:migrate` once. Do not retry blindly after an interruption; inspect the Drizzle ledger and schema first.
6. Run `npm run db:verify:applied`. This checks migration hashes and expected schema without applying additional migrations.
7. Re-run a read-only query to verify that `content_products`, `publication_jobs.tiktok_approval`, and `media_assets.duration_seconds` now exist and that the ledger matches the approved release journal.
8. Run authenticated API smoke tests and confirm `/api/v1/health` and `/api/v1/ready` return expected results. Review logs for schema errors.
9. Record the release commit, migration timestamps, verification output, operator, approval, and recovery point in the deployment record. Never record secrets.

## Stop / recovery criteria

Stop immediately if the target database identity is unclear, backup/recovery is unconfirmed, migration journal validation fails, the schema differs from the expected starting state, or the migrator reports an error. Do not manually insert rows into `drizzle.__drizzle_migrations`, mark a failed migration as applied, or run the SQL by hand to make verification pass. Preserve logs without credentials, inspect the actual database state, and obtain database-owner review before a retry or recovery action.

If verification fails after migration, keep traffic/deployment decisions with the production operator, capture the sanitized error and schema/ledger findings, and use the approved Supabase recovery process if necessary. Never improvise a rollback of DDL without reviewing data impact.

## Relationship to PR #413

PR #413's grants migration is a separate defense-in-depth change. A successful CI run does not prove production role grants or the runtime API's database role. Keep that PR in Draft until the production schema is reconciled and the role/grant behavior has been reviewed independently.
