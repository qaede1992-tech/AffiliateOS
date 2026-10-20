# Supabase Storage Media Integration Plan

Status: implementation in progress on draft PR #437. The storage adapter and upload-domain validation foundation are implemented and CI-validated; the HTTP upload route and publisher integration are not implemented yet. This work does not create a bucket, change production configuration, or apply database migrations.

## Current implementation findings

- `media_assets` stores media metadata and a `source` / `reference`; it does not itself upload or retrieve binary files.
- The publisher executor resolves media asset records and passes their metadata to publisher adapters.
- A dependency-free server-side Supabase Storage REST adapter now exists in `apps/api/src/domain/supabase-storage.ts`; its service credential remains server-only.
- `.env.example` documents the optional `SUPABASE_URL`, `SUPABASE_STORAGE_SERVICE_KEY`, and `SUPABASE_MEDIA_BUCKET` settings as blank placeholders. The settings are not yet wired into runtime configuration.
- `MediaUploadService` validates content UUID/existence, allowed MIME type, basic file signature, byte limits, and duration, then uploads and persists bucket/key metadata with best-effort cleanup if metadata persistence fails. It is a domain foundation only; no HTTP route calls it yet.
- The current `object-storage` source accepts an opaque reference, so it does not prove that an arbitrary persisted reference points to an existing object or that it is safe to publish.
- The current TikTok and Instagram adapters are URL-oriented in important paths: TikTok photo posting requires a URL, TikTok's default video transfer mode is `FILE_UPLOAD` and expects an HTTPS source it can download, while Instagram requires a public HTTPS media URL. The adapters do not yet resolve private Storage objects into a provider-compatible transfer flow.
- Fastify is configured with a 1 MiB request body limit in `apps/api/src/app.ts`, and no media upload route or multipart plugin was found in the inspected route registration. Binary upload therefore needs an explicit, bounded streaming design; raising the global limit is not an acceptable shortcut.

## Target design

1. Keep PostgreSQL as the source of truth for media metadata and ownership.
2. Store image/video bytes in a **private** Supabase Storage bucket. Use stable object keys, not public URLs, as persisted references.
3. Perform uploads and deletes only through server-side API code. Never expose a Supabase service-role secret to the web app, logs, API responses, or client bundles.
4. Validate media kind, MIME type, byte size, and duration before accepting an upload. Enforce configurable limits and reject unsupported types.
5. Add a dedicated multipart or raw-stream upload route with an explicit per-file size limit, request timeout, backpressure, and early rejection. Keep the existing global 1 MiB API body limit unchanged for JSON endpoints.
6. Persist the storage bucket/key and verified metadata in `media_assets`; only mark an upload complete after Storage confirms success. If metadata persistence fails after upload, clean up the object or record it for retry.
7. Resolve objects server-side for publication. Use short-lived signed URLs only for providers that require a fetchable URL; use upload/stream APIs when the provider supports them. Provider pull URLs must remain reachable for the provider's full fetch window, so URL expiry and container-processing delays need tests.
8. For TikTok `FILE_UPLOAD`, implement a bounded server-side download/stream from Storage into TikTok's upload URL, or explicitly generate a signed URL only for a supported pull-from-URL mode. Do not pass a private object key as if it were an HTTPS URL.
9. For TikTok photo posts and Instagram media containers, provide a provider-compatible URL without making the bucket public. Confirm each provider's signed-URL/fetch requirements and expiration behavior before rollout.
10. Ensure authorization checks bind the asset to its content and account before issuing a signed URL or publishing. Do not accept arbitrary bucket/key values from untrusted callers.
11. Add cleanup for abandoned uploads and deleted assets, with retries and observability that never logs credentials or signed URLs.
12. Keep existing HTTPS URL assets compatible during migration; do not silently reinterpret existing references as Storage keys.

## Proposed configuration

- `SUPABASE_URL`
- A server-only Storage credential with only the permissions required for the private bucket, where supported by the deployment model.
- `SUPABASE_MEDIA_BUCKET`
- Configurable upload byte limits and signed-URL expiry.

Use the existing secret-management/deployment mechanism. Do not put credentials in source control or `.env.example` with real values. Runtime configuration wiring is still pending; blank example variables do not activate the adapter.

## Implementation sequence

1. [x] Inspect provider-specific media flow and service/container wiring.
2. [x] Add the dependency-free Supabase Storage adapter and upload-domain validation foundation with unit tests.
3. [ ] Wire storage settings into runtime configuration and service construction without exposing secrets.
4. [ ] Add a dedicated API upload route with authentication, content ownership checks, bounded streaming, request limits, and safe error mapping. Do not raise the global 1 MiB body limit.
5. [ ] Integrate upload completion/deletion with `media_assets`, including compensation/retry behavior.
6. [ ] Update publisher adapters one platform at a time, matching provider media-transfer contracts.
7. [ ] Add tests for streaming limits, missing objects, cross-content access, signed URL expiry, Storage failures, DB failures, cleanup, and existing URL compatibility.
8. [x] Validate current adapter/domain foundation in CI: test, typecheck, build, migration checks, migration simulation, and API/web container smoke tests passed for commit `b4653489df0dc12792e7b83d217f014feecae5bd`.

## Safety and rollout gates

- No production bucket or policy changes are part of this proposal.
- Do not make the bucket public to work around publisher URL requirements.
- Do not modify historical migration timestamps or bypass migration guards.
- Add a new migration only if the existing schema cannot represent the needed storage metadata; timestamp it after the current ledger maximum and test against a restored schema.
- Keep this change in a draft PR until implementation, CI, and operator review are complete.
