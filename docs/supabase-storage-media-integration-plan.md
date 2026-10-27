# Supabase Storage Media Integration

Status: storage upload and publisher-resolution foundations are implemented in code. This branch adds a server-side resolver that turns private object references into short-lived HTTPS signed URLs immediately before publisher execution. It does not enable external publication, change bucket visibility, modify production configuration, or apply database migrations. CI and operator validation are still required.

## Current flow

- `SUPABASE_URL`, `SUPABASE_STORAGE_SERVICE_KEY`, and `SUPABASE_MEDIA_BUCKET` are parsed by the API configuration; the server constructs a Storage client and injects it into the service container.
- `POST /api/v1/content/media-upload` uses the media upload service with bounded request handling and file validation. The service stores bytes in the configured bucket and persists a bucket/key reference in `media_assets`.
- The publisher executor checks that each media asset belongs to the content being published.
- For `source: "object-storage"`, the new publisher media resolver verifies the configured bucket and the `content/{contentId}/` object-key scope, then asks the server-side Storage client for a signed URL with a maximum one-hour lifetime. The resolver only passes this transient URL to the publisher; it does not rewrite the persisted media record.
- Existing `source: "url"` assets continue to pass through unchanged.
- TikTok photo posting and Instagram media containers can receive the HTTPS URL; TikTok's `FILE_UPLOAD` video flow can download the signed URL server-side and transfer the bytes to TikTok. This is implementation-level compatibility, not proof of a successful live post.

## Security requirements

1. Keep the Storage bucket private and the service credential server-side.
2. Never return or log signed URLs or service credentials. Treat signed URLs as bearer links.
3. Only sign keys from the configured bucket and within the publishing content's own `content/{contentId}/` prefix.
4. Keep signed URL lifetime bounded; current resolver requests 3600 seconds, the Storage adapter's maximum.
5. Do not reinterpret arbitrary references as Storage objects or change stored references during publication.
6. Keep external publication disabled while validating provider behavior, permissions, media formats, and signed-URL fetch behavior.
7. Do not change TikTok's explicit publication-approval flow or enable autonomous external publication as part of this work.

## Validation still required

- Run API tests, TypeScript typecheck, and full build in CI.
- Confirm resolver tests cover signed URL creation, missing Storage configuration, bucket mismatch, cross-content key rejection, and compatibility with existing HTTPS assets.
- Confirm Storage signed URLs are fetchable by the configured Instagram/TikTok API flows under their real access and media requirements.
- Perform a controlled test against a non-production social account only after explicit operator approval; no live post is authorized by this code change.
- Verify production API configuration and Storage bucket access without printing secrets.
- Do not merge or deploy until CI is green and the operator has reviewed the PR.

## Out of scope

- Making the bucket public.
- Changing production secrets, Storage policies, database schema, or migrations.
- Publishing any content to external platforms.
- Automatically retrying failed publication runs or rebinding them to different affiliate offers.
