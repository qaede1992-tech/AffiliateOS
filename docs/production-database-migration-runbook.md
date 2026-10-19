# Production database migration runbook

> **Audit update — 2026-10-19 (supersedes stale current-state counts below).** The latest read-only Supabase audit available to the project reports 54 rows in `drizzle.__drizzle_migrations`; the newest recorded migration is `0059_reconcile_missing_tiktok_and_content_products` with timestamp `1794050405000`. Migration `0060_test_data_retention_markers` is not recorded. The audit found both `campaigns.is_test` and `autonomous_runs.is_test` absent, along with indexes `campaigns_test_created_idx` and `autonomous_runs_test_created_idx`. The journal timestamp for 0060 is `1794050405001`, one unit greater than the production ledger maximum, so timestamp ordering alone does not explain why 0060 is missing. Recheck all four schema objects and the ledger against production immediately before any approved change. Therefore, do **not** run the test-data retention preview against production yet: it depends on those columns. This is a read-only finding only; no migration, data mutation, or deletion was performed.
>
> The historical audit below describes the earlier 2026-10-16 state (53 ledger rows and 0059 as a candidate). Treat those counts and the statement that 0059 is still a candidate as historical, not current. The production ledger now records 0059. The separate question of applying 0060 remains blocked until the exact approved release commit, migration selection behavior, backup/restore evidence, and production operator approval are confirmed. Do not infer that CI or a GitHub Release applied a migration to Supabase.
>
> **Release/deployment distinction:** repository workflows currently build and smoke-test immutable API/web images and run migrations against disposable PostgreSQL. They do not establish that Supabase production migrations or Blitz Cloud deployment were executed. Verify these separately in the actual production environment.

# Production database migration runbook

This runbook is for an authorized operator applying AffiliateOS Drizzle migrations to the production PostgreSQL database. It does not authorize changing the database endpoint, role grants, RLS policies, or application deployment configuration.

## Historical audit snapshot (2026-10-16; superseded by the audit update above)

The read-only production audit, reconfirmed on 2026-10-16, found 53 Drizzle ledger rows and still did not find:
- `publication_jobs.confirmed_at` (also confirmed by repeated production query errors on 2026-10-16; the deployed publication worker selects this field)
- `publication_jobs.tiktok_approval` (migration `0056_tiktok_publication_approval_and_media_duration`)
- `media_assets.duration_seconds` (migration `0056_tiktok_publication_approval_and_media_duration`)
- `content_products` (migration `0057_content_products_multi_product_story`)

A follow-up read-only query confirmed that the production ledger's maximum `created_at` is `1794050403000`, while journal timestamps for migrations `0056` and `0057` are `1791676800000` and `1791763200000`. In the checked-out journal, the maximum timestamp belongs to `0046_autonomous_action_recovery_policy` (index 43); later journal entries include timestamps lower than that maximum. Thus the journal's index order and timestamp order diverge, and Drizzle's timestamp-based selection can skip an unapplied migration whose timestamp is below the ledger maximum. The ledger rows are not monotonically increasing by timestamp when ordered by row ID. This is not limited to production drift: on a clean database, after a later timestamp such as 0046 has been applied, the timestamp-based migrator may also skip 0056/0057. The forward-only reconciliation 0059 must therefore create the expected objects whether 0056/0057 were skipped or are already reflected in the schema. The missing migrations cannot be treated as a simple two-migration lag. A complete read-only comparison of all 53 production ledger rows against the 55-entry `main` journal subsequently confirmed that all 53 ledger timestamps map to known journal entries and all 53 hashes match the corresponding SQL under LF or CRLF line endings; there are no duplicate ledger timestamps, unknown ledger timestamps, or substantive hash mismatches. The only journal entries absent from the ledger are `0056` and `0057`, and their expected schema objects are absent.

**Do not run `npm run db:migrate` against production yet.** Drizzle migrators commonly determine pending migrations using the latest ledger timestamp; with a later timestamp already recorded, migrations `0056` and `0057` may be skipped even though their schema objects are absent. Confirm the exact behavior of the repository's pinned Drizzle version against a disposable database and inspect the full timestamp/hash mapping before choosing a repair. Do not rewrite migration history, delete ledger rows, or manually insert ledger records to force the migrator forward.

The proposed forward-only repair is migration `0059_reconcile_missing_tiktok_and_content_products`, timestamp `1794050405000`, which is strictly greater than the audited production ledger maximum (`1794050403000`). It idempotently adds the three nullable columns (`publication_jobs.confirmed_at`, `publication_jobs.tiktok_approval`, and `media_assets.duration_seconds`) and creates `content_products` plus its three indexes. Important: the journal is not timestamp-monotonic—an earlier journal entry (`0046`) has timestamp `1794050403000`, greater than the timestamps for `0056` and `0057`. Because Drizzle selects pending migrations by timestamp, `0056`/`0057` can be skipped even on a clean database. Therefore 0059 must create the expected objects on both clean and drifted databases; do not describe it as a no-op on clean databases. The broad grants change previously proposed as 0058 has been removed from this repair PR and is deferred for independent security review. Historical note: 0059 is now recorded in the latest production ledger audit. The paragraph above explains why it was proposed at the time; it is not the current status of 0059 and does not authorize production execution.

Do not assume the production database is current merely because the API and web health endpoints return 200.

## Required safeguards

1. Schedule a maintenance window and identify the person authorized to approve production database changes.
2. This deployment uses the Supabase Free Plan, where the operator has confirmed Supabase-managed backups are unavailable. Before applying DDL, create a fresh manual PostgreSQL dump from the existing production Pooler connection, calculate and record its SHA-256 checksum, and restore it successfully into an isolated test database. Verify the restored schema and critical data, record the dump timestamp and restore result without recording credentials, and identify the recovery owner. A previously tested dump is not sufficient if it may predate recent production writes.
3. Confirm the target is the AffiliateOS production project and its existing Supabase Pooler endpoint. Do not switch to Direct Connection as part of this procedure.
4. Confirm the deployed API version and the release commit whose migrations will be applied.
5. Keep the database URL in the approved secret store or the operator's protected local environment. Never paste it into issues, PR comments, chat, shell transcripts, or logs.
6. Do not use the Supabase SQL editor to run Drizzle migration SQL manually. Use the repository's reviewed migration workflow so schema and the migration ledger remain consistent.
7. Do not enable RLS across all tables or modify application-role grants as a side effect of this migration window.

## Operator procedure

Run from a trusted, clean checkout of the exact approved release commit, using Node.js 24 and the repository lockfile. Use a protected environment file or injected environment variable for `DATABASE_URL`; do not commit it.

1. Review the exact migration diff and journal entries. Confirm no unrelated migration is being introduced.
2. Run `npm ci` and `npm run db:check`; stop if migration journal validation fails.
3. Run a read-only preflight against the target: verify database identity, ledger count, maximum timestamp, every ledger timestamp/hash (accepting only exact SQL content with LF or CRLF line endings), and presence/absence of the three schema objects listed above. For the 2026-10-15 audit, all 53 existing ledger rows matched the corresponding journal timestamps and hashes; only `0056` and `0057` were absent. Repeat this comparison against the exact approved release commit before applying anything.
4. Reproduce migration selection behavior with the pinned Drizzle version against a disposable database seeded with a representative copy of the ledger timestamps. Verify that the pending-migration plan actually addresses the absent schema objects.
5. The candidate repair is `0059_reconcile_missing_tiktok_and_content_products`. Its timestamp must remain strictly greater than the production maximum and all earlier journal timestamps. This repair must not change role grants or RLS policies. Confirm the actual schema matches the audited starting state before applying; stop on partial or incompatible objects. Do not alter old journal timestamps or production ledger rows. Test it on a clean CI database and a disposable database that matches the production drift pattern.
6. Stop until the ledger discrepancy and remediation are fully explained, CI passes, the fresh manual dump has passed checksum and isolated-restore verification, the recovery procedure and owner are documented, and the authorized production operator explicitly approves the change.
7. Apply only the approved migration through the repository's official migrator once. Do not retry blindly after interruption; inspect actual schema and ledger first.
8. Run `npm run db:verify:applied` and re-query the schema and ledger. The updated verifier permits the two historical gaps only when the exact `0059` compensation timestamp is recorded, its hash matches, and all expected columns/table/indexes exist. It must clearly report the compensated gaps; it must not fabricate ledger entries for 0056/0057. Confirm `content_products`, `publication_jobs.tiktok_approval`, and `media_assets.duration_seconds` exist, and verify all other migration hashes.
9. Run authenticated API smoke tests and confirm `/api/v1/health` and `/api/v1/ready` return expected results. Review logs for schema errors.
10. Record the release commit, migration timestamps, verification output, operator, approval, and recovery point in the deployment record. Never record secrets.

## Stop / recovery criteria

Stop immediately if the target database identity is unclear, a fresh manual dump is missing or its checksum/isolated restore/schema-and-data verification fails, the recovery owner/procedure is unclear, migration journal validation fails, any ledger timestamp/hash is unmatched or unexplained, the migrator would skip required schema changes, the schema differs from the expected starting state, or the migrator reports an error. Do not manually insert rows into `drizzle.__drizzle_migrations`, mark a failed migration as applied, delete migration history, or run SQL by hand to make verification pass. Preserve logs without credentials, inspect the actual database state, and obtain database-owner review before a retry or recovery action.

If verification fails after migration, keep traffic/deployment decisions with the production operator, capture the sanitized error and schema/ledger findings, and use the approved Supabase recovery process if necessary. Never improvise a rollback of DDL without reviewing data impact.

## Deferred grants hardening

The broad grants migration previously proposed in PR #413 is intentionally excluded from this schema-repair PR. A successful CI run does not prove production role grants or the runtime API's database role. Keep PR #413 in Draft pending a separate read-only audit of actual grants, the API runtime database role, and Supabase/PostgREST behavior. If this repair migration lands first, retimestamp the separate grants migration to be strictly greater than `1794050405000` and rerun the append-only timestamp guard; do not rewrite any migration already present on `main`.
