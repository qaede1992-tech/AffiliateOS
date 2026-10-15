# Production database migration runbook

This runbook is for an authorized operator applying AffiliateOS Drizzle migrations to the production PostgreSQL database. It does not authorize changing the database endpoint, role grants, RLS policies, or application deployment configuration.

## Current known blocker (audited 2026-10-15)

The read-only production audit found 53 Drizzle ledger rows and did not find:
- `publication_jobs.tiktok_approval` (migration `0056_tiktok_publication_approval_and_media_duration`)
- `media_assets.duration_seconds` (migration `0056_tiktok_publication_approval_and_media_duration`)
- `content_products` (migration `0057_content_products_multi_product_story`)

A follow-up read-only query confirmed that the production ledger's maximum `created_at` is `1794050403000`, while journal timestamps for migrations `0056` and `0057` are `1791676800000` and `1791763200000`. The ledger rows are also not in monotonically increasing timestamp order by row ID. The missing migrations therefore cannot be treated as a simple two-migration lag.

**Do not run `npm run db:migrate` against production yet.** Drizzle migrators commonly determine pending migrations using the latest ledger timestamp; with a later timestamp already recorded, migrations `0056` and `0057` may be skipped even though their schema objects are absent. Confirm the exact behavior of the repository's pinned Drizzle version against a disposable database and inspect the full timestamp/hash mapping before choosing a repair. Do not rewrite migration history, delete ledger rows, or manually insert ledger records to force the migrator forward.

The next safe engineering step is to prepare and test a forward-only corrective migration with a new timestamp later than the current production maximum, after confirming the actual starting schema, constraints, dependencies, and whether any of the intended objects partially exist. It must be reviewed against the exact production findings and run through CI on a clean database before any production application. This is a proposed remediation path, not an authorization to deploy it.

Do not assume the production database is current merely because the API and web health endpoints return 200.

## Required safeguards

1. Schedule a maintenance window and identify the person authorized to approve production database changes.
2. Confirm a recent, restorable Supabase backup/PITR recovery point and the recovery owner before applying DDL.
3. Confirm the target is the AffiliateOS production project and its existing Supabase Pooler endpoint. Do not switch to Direct Connection as part of this procedure.
4. Confirm the deployed API version and the release commit whose migrations will be applied.
5. Keep the database URL in the approved secret store or the operator's protected local environment. Never paste it into issues, PR comments, chat, shell transcripts, or logs.
6. Do not use the Supabase SQL editor to run Drizzle migration SQL manually. Use the repository's reviewed migration workflow so schema and the migration ledger remain consistent.
7. Do not enable RLS across all tables or modify application-role grants as a side effect of this migration window.

## Operator procedure

Run from a trusted, clean checkout of the exact approved release commit, using Node.js 24 and the repository lockfile. Use a protected environment file or injected environment variable for `DATABASE_URL`; do not commit it.

1. Review the exact migration diff and journal entries. Confirm no unrelated migration is being introduced.
2. Run `npm ci` and `npm run db:check`; stop if migration journal validation fails.
3. Run a read-only preflight against the target: verify database identity, ledger count, maximum timestamp, every ledger timestamp/hash, and presence/absence of the three schema objects listed above. Compare the entire ledger with the journal for the exact release commit.
4. Reproduce migration selection behavior with the pinned Drizzle version against a disposable database seeded with a representative copy of the ledger timestamps. Verify that the pending-migration plan actually addresses the absent schema objects.
5. If normal migration selection skips the missing changes, prepare a reviewed forward-only corrective migration with a timestamp greater than the production maximum and appropriate guards for the audited starting schema. Do not alter old journal timestamps or production ledger rows. Test it on a clean CI database and a disposable database that matches the production drift pattern.
6. Stop until the ledger discrepancy and remediation are fully explained, CI passes, backup/recovery is confirmed, and the authorized production operator explicitly approves the change.
7. Apply only the approved migration through the repository's official migrator once. Do not retry blindly after interruption; inspect actual schema and ledger first.
8. Run `npm run db:verify:applied` and re-query the schema and ledger. Confirm `content_products`, `publication_jobs.tiktok_approval`, and `media_assets.duration_seconds` exist, and verify the approved migration hashes.
9. Run authenticated API smoke tests and confirm `/api/v1/health` and `/api/v1/ready` return expected results. Review logs for schema errors.
10. Record the release commit, migration timestamps, verification output, operator, approval, and recovery point in the deployment record. Never record secrets.

## Stop / recovery criteria

Stop immediately if the target database identity is unclear, backup/recovery is unconfirmed, migration journal validation fails, any ledger timestamp/hash is unmatched or unexplained, the migrator would skip required schema changes, the schema differs from the expected starting state, or the migrator reports an error. Do not manually insert rows into `drizzle.__drizzle_migrations`, mark a failed migration as applied, delete migration history, or run SQL by hand to make verification pass. Preserve logs without credentials, inspect the actual database state, and obtain database-owner review before a retry or recovery action.

If verification fails after migration, keep traffic/deployment decisions with the production operator, capture the sanitized error and schema/ledger findings, and use the approved Supabase recovery process if necessary. Never improvise a rollback of DDL without reviewing data impact.

## Relationship to PR #413

PR #413's grants migration is a separate defense-in-depth change. A successful CI run does not prove production role grants or the runtime API's database role. Keep that PR in Draft until the production schema is reconciled and the role/grant behavior has been reviewed independently.
