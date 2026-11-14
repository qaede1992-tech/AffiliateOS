# Production database and Storage backup/restore runbook

**Purpose:** create a fresh, independently retained, restorable backup of AffiliateOS Production before any Production DDL, including migrations 0076–0083. This document is an operator procedure, not authorization to run a migration.

## Current audited Production scope (2026-11-06)

- Supabase Production project ref: `jgiimqksgibovxheibbs`.
- Organization plan was observed as Free during the 2026-11-06 audit; do not assume managed daily backups are available.
- Private Storage bucket: `affiliate-media`.
- Latest read-only Storage inventory: 4 objects, approximately 1,602,036 bytes. Re-inventory immediately before backup; this count is not a permanent expectation.
- Staging is not a backup target and must not be overwritten for restore testing.
- Historical dump `affiliateos-production-20261016-071247Z.dump` is not a sufficiently fresh recovery point for the planned migrations.

## Non-negotiable safeguards

1. Use a trusted operator workstation and a protected local backup directory outside the repository. Do not put dumps, object files, connection strings, database passwords, access tokens, or Storage keys in GitHub, chat, application logs, or the repository.
2. The Supabase CLI `db dump` command runs `pg_dump` in a Docker container. Install and start Docker Desktop before using this method. The previous AffiliateOS workstation audit found Docker was not installed; if that remains true, stop and install Docker Desktop or use another trusted workstation with Docker. Do not substitute an unfiltered raw `pg_dump` command.
3. Use the Supabase CLI's supported `db dump` path. It excludes Supabase-managed schemas (including `auth` and `storage`) and extension-managed schemas. Export customizations in managed schemas separately.
4. Back up Storage object bytes separately from the database. The database dump does not contain Storage object bytes.
5. Never restore onto Production or Staging. Restore into a disposable isolated PostgreSQL/Supabase target with sufficient extensions and roles. Do not create that target if it would incur unapproved cost.
6. Do not run `supabase db push`, `supabase migration up`, Drizzle migrations, or any DDL against Production as part of backup creation.

## A. Prepare the workstation

Run PowerShell from a trusted local folder, not inside the AffiliateOS Git checkout:

```powershell
supabase --version
docker version
docker info
psql --version
$BackupRoot = "C:\AffiliateOS-backups"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path $BackupRoot "affiliateos-production-$Stamp"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
```

Stop if Docker is unavailable, Docker daemon is not running, or the Supabase CLI is missing. Record the CLI, Docker, and PostgreSQL client versions in the backup manifest.

Authenticate with the Supabase CLI and link only the Production project:

```powershell
supabase login
supabase link --project-ref jgiimqksgibovxheibbs
```

The CLI may prompt for the database password. Enter it only into the trusted interactive prompt. Do not put it in a command line, script, environment file, or transcript. Confirm the linked project ref in the CLI output before proceeding. If the linked project is not the exact Production ref above, stop.

## B. Export database roles, schema, and data

From the same linked project directory, save all output directly into the protected backup directory:

```powershell
supabase db dump --db-url $env:AFFILIATEOS_PRODUCTION_DB_URL -f (Join-Path $BackupDir "roles.sql") --role-only
if ($LASTEXITCODE -ne 0) { throw "Production role export failed" }

supabase db dump --db-url $env:AFFILIATEOS_PRODUCTION_DB_URL -f (Join-Path $BackupDir "schema.sql")
if ($LASTEXITCODE -ne 0) { throw "Production schema export failed" }

supabase db dump --db-url $env:AFFILIATEOS_PRODUCTION_DB_URL -f (Join-Path $BackupDir "data.sql") --use-copy --data-only
if ($LASTEXITCODE -ne 0) { throw "Production data export failed" }
```

Do not continue unless all three files exist and are non-empty:

```powershell
Get-Item (Join-Path $BackupDir "roles.sql"), (Join-Path $BackupDir "schema.sql"), (Join-Path $BackupDir "data.sql") |
  Select-Object Name, Length, LastWriteTimeUtc
```

The official CLI guide documents `--db-url`, `--role-only`, `--data-only`, and `--use-copy`. The command intentionally does not add raw `pg_dump` switches: Supabase CLI applies its own filtering, including excluding managed `auth` and `storage` schemas. Do not assume these three exports contain Storage object bytes.

## C. Export Storage objects and metadata separately

Immediately before copying, re-inventory the private `affiliate-media` bucket in the Production Dashboard and through read-only SQL. Save the results in the backup directory:

- Bucket row from `storage.buckets`: id, name, public flag, file size limit, allowed MIME types, and other configured fields.
- Every object row from `storage.objects` in that bucket: name/path, bucket_id, metadata, size, MIME type, cache control, and timestamps where available.
- Every policy on `storage.objects` and `storage.buckets` from `pg_policies`, plus any custom trigger/function affecting Storage.
- Object count and total bytes, reconciled with the Storage Dashboard.

Download every object from Storage > Files in the Supabase Dashboard (or use the documented Supabase Storage CLI copy command after validating its current syntax). Preserve each exact object path and filename in a local folder tree. Do not make the bucket public and do not use public URLs to fetch private objects.

Create a SHA-256 manifest for every downloaded object:

```powershell
Get-ChildItem (Join-Path $BackupDir "affiliate-media") -File -Recurse |
  Get-FileHash -Algorithm SHA256 |
  Select-Object Path, Hash |
  Export-Csv (Join-Path $BackupDir "storage-sha256.csv") -NoTypeInformation
```

Reconcile the local object count and byte total against the fresh source inventory. If even one object is missing, has a size mismatch, or has an unexplained path mismatch, the Storage backup is incomplete.

**Important:** `storage.objects` metadata and bucket policies are not a substitute for the actual object bytes. On restore, recreate the private bucket configuration and policies through supported Supabase controls, then upload the saved bytes through Storage APIs/UI. Do not directly insert or rewrite Supabase-managed Storage object rows with SQL.

## D. Capture managed-schema customizations

Because the CLI dump excludes Supabase-managed `auth` and `storage` schemas, capture customizations separately before declaring the backup complete. At minimum, export the applicable policy definitions, custom triggers, and custom functions that AffiliateOS owns in those schemas. Record the SQL used to retrieve them and the resulting files. Do not attempt to dump or recreate Supabase's internal platform objects wholesale.

If using Supabase schema diff, follow the documentation for the project's configured diff engine. The pg-delta and legacy migra paths differ; do not guess which applies. Any customization not captured and restored must be listed as an explicit backup limitation.

## E. Checksums and immutable retention

After all exports are complete, calculate SHA-256 checksums for the database SQL files, Storage metadata exports, policy/customization exports, and every Storage object. Save the manifest beside the files, then copy the complete backup directory to a separate protected storage destination outside the Production Supabase project and outside the application host.

The backup is not complete until:
- all files are present and non-empty;
- the Storage object count and byte total reconcile with Production;
- checksums verify after the second copy;
- the second copy is accessible independently of the workstation;
- the backup timestamp and source project ref are recorded without credentials.

Do not store the only backup copy in the same Supabase project, Blitz app volume, or GitHub repository.

## F. Restore test in an isolated target

Use a new disposable Supabase project or isolated PostgreSQL environment that is not Production or Staging. Ensure required extensions and compatible roles exist. Restore in a controlled sequence using the Supabase-documented `psql` procedure with `--single-transaction` and `ON_ERROR_STOP=1`. Follow the official privilege guidance before restoring schema so default privileges in the target do not unintentionally grant table access to `anon` or `authenticated`.

For the database restore, the official Supabase CLI guide uses `roles.sql`, `schema.sql`, then `data.sql`, setting `session_replication_role = replica` for the data load. Do not improvise if a role, extension, or managed-schema dependency fails; record the failure and correct the isolated target first.

For Storage restore:
1. Recreate `affiliate-media` as a private bucket with the captured configuration.
2. Recreate only the reviewed custom Storage policies and customizations.
3. Upload each saved object to its exact original path using Storage APIs/UI.
4. Download each restored object again and compare SHA-256 against the original manifest.
5. Reconcile restored object count and total bytes.

Verify the restored database:
- expected application schemas and critical tables exist;
- row counts for critical AffiliateOS tables are plausible and match source snapshots where exact equality is expected;
- Drizzle migration ledger count, timestamps, and hashes match the backup snapshot;
- foreign keys, indexes, RLS state, grants, and required extensions are present;
- no credential values were copied into the manifest or logs.

Record the restore target, timestamp, commands, results, differences, and operator. Destroy the disposable target only after evidence has been retained and only under the target project's approved lifecycle policy.

## G. Production migration gate

The Production migration workflow's `confirm_backup_completed` input is an operator attestation, not a technical backup verifier. Do not check it until sections A–F have passed and the restore evidence is recorded.

Only then may the separate, reviewed Production migration process be considered. The migration workflow must still verify its exact 0075 starting boundary and schema state. Stop on any mismatch. This runbook itself never authorizes migration execution.

## Official references

- Supabase backup and restore using CLI: https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
- Supabase CLI `db dump`: https://supabase.com/docs/reference/cli/v0/supabase-db-dump
- Supabase Storage object download: https://supabase.com/docs/guides/storage/management/download-objects
- Supabase database backups and Storage exclusion: https://supabase.com/docs/guides/platform/backups
