# Supabase Storage Media Integration Plan

Status: proposal only. This document does not create a bucket, change production configuration, or apply database migrations.

## Current implementation findings

- `media_assets` stores media metadata and a `source` / `reference`; it does not itself upload or retrieve binary files.
- The publisher executor resolves media asset records and passes their metadata to publisher adapters.
- The API package currently has no Supabase client dependency or documented Storage-specific environment configuration.
- The current `object-storage` source accepts an opaque reference, so it does not prove that the object exists or that it belongs to the expected content.

## Target design

1. Keep PostgreSQL as the source of truth for media metadata and ownership.
2. Store image/video bytes in a **private** Supabase Storage bucket. Use stable object keys, not public URLs, as persisted references.
3. Perform uploads and deletes only through server-side API code. Never expose a Supabase service-role secret to the web app, logs, API responses, or client bundles.
4. Validate media kind, MIME type, byte size, and duration before accepting an upload. Enforce configurable limits and reject unsupported types.
5. Persist the storage bucket/key and verified metadata in `media_assets`; only mark an upload complete after Storage confirms success. If metadata persistence fails after upload, clean up the object or record it for retry.
6. Resolve objects server-side for publication. Use short-lived signed URLs only for providers that require a fetchable URL; use upload/stream APIs when the provider supports them. Do not assume every social provider accepts the same media URL or upload protocol.
7. Ensure authorization checks bind the asset to its content and account before issuing a signed URL or publishing. Do not accept arbitrary bucket/key values from untrusted callers.
8. Add cleanup for abandoned uploads and deleted assets, with retries and observability that never logs credentials or signed URLs.
9. Keep existing HTTPS URL assets compatible during migration; do not silently reinterpret existing references as Storage keys.

## Proposed configuration

- `SUPABASE_URL`
- A server-only Storage credential with only the permissions required for the private bucket, where supported by the deployment model.
- `SUPABASE_MEDIA_BUCKET`
- Configurable upload byte limits and signed-URL expiry.

Use the existing secret-management/deployment mechanism. Do not put credentials in source control or `.env.example` with real values.

## Implementation sequence

1. Inspect provider-specific media upload requirements and the service/container wiring.
2. Add a storage interface with a fake/in-memory implementation for unit tests and a Supabase Storage adapter.
3. Add upload validation and an API route with authentication, ownership checks, bounded streaming, and safe error mapping.
4. Integrate upload completion and deletion with `media_assets`, including compensation/retry behavior.
5. Update publisher adapters one platform at a time, matching each provider's documented media-upload contract.
6. Add tests for MIME/size limits, missing objects, cross-content access, expired signed URLs, Storage failures, DB failures, cleanup, and existing URL compatibility.
7. Run typecheck, tests, build, database checks, and production preflight. Review deployment configuration before any rollout.

## Safety and rollout gates

- No production bucket or policy changes are part of this proposal.
- Do not make the bucket public to work around publisher URL requirements.
- Do not modify historical migration timestamps or bypass migration guards.
- Add a new migration only if the existing schema cannot represent the needed storage metadata; timestamp it after the current ledger maximum and test against a restored schema.
- Keep this change in a draft PR until implementation, CI, and operator review are complete.
