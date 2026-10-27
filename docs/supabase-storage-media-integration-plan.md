# Supabase Storage Media Integration

Status: storage upload and publisher-resolution foundations are implemented in code. This branch adds a server-side resolver that turns private object references into short-lived HTTPS signed URLs immediately before publisher execution. It does not enable external publication, change bucket visibility, modify production configuration, or apply database migrations. CI is green, but provider-specific media delivery is not yet verified.

## Current flow

- `SUPABASE_URL`, `SUPABASE_STORAGE_SERVICE_KEY`, and `SUPABASE_MEDIA_BUCKET` are parsed by the API configuration; the server constructs a Storage client and injects it into the service container.
- `POST /api/v1/content/media-upload` uses the media upload service with bounded request handling and file validation. The service stores bytes in the configured bucket and persists a bucket/key reference in `media_assets`.
- The publisher executor checks that each media asset belongs to the content being published.
- For `source: "object-storage"`, the publisher media resolver verifies the configured bucket and the `content/{contentId}/` object-key scope, then asks the server-side Storage client for a signed URL with a maximum one-hour lifetime. The resolver only passes this transient URL to the publisher; it does not rewrite the persisted media record.
- Existing `source: "url"` assets continue to pass through unchanged.
- TikTok's existing video `FILE_UPLOAD` path may fetch a signed URL server-side and transfer the bytes to TikTok. Preserve that path unless a separately tested change is required.
- Do not assume a Supabase-hosted signed URL is acceptable for TikTok photo posting. TikTok's `PULL_FROM_URL` flow requires a domain or URL prefix owned by and verified for the developer, HTTPS, no redirects, and access for the full download process. The current one-hour signed URL lifetime equals the documented maximum processing window and provides no timing margin.
- Instagram media-container compatibility also remains unverified until the provider can fetch the signed URL and the media meets its current format/access requirements.

## Security requirements

1. Keep the Storage bucket private and the service credential server-side.
2. Never return or log signed URLs or service credentials. Treat signed URLs as bearer links.
3. Only sign keys from the configured bucket and within the publishing content's own `content/{contentId}/` prefix.
4. Keep signed URL lifetime bounded. Do not assume the current 3600-second value is suitable for every provider.
5. Do not reinterpret arbitrary references as Storage objects or change stored references during publication.
6. Keep external publication disabled while validating provider behavior, permissions, media formats, verified-domain requirements, and signed-URL fetch behavior.
7. Do not change TikTok's explicit publication-approval flow or enable autonomous external publication as part of this work.

## Validation still required

- CI tests, TypeScript typecheck, and full build passed for the current code commit.
- Resolver tests cover signed URL creation, missing Storage configuration, bucket mismatch, cross-content key rejection, and compatibility with existing HTTPS assets.
- Verify signed URL fetchability without printing the URL, query string, service credential, or authorization headers in logs.
- For TikTok photo `PULL_FROM_URL`, confirm a developer-owned domain/prefix is actually verified and used. Do not assume the Supabase project domain qualifies. If it does not, evaluate a verified AffiliateOS-owned HTTPS media endpoint that proxies private Storage without making the bucket public.
- Preserve and separately test TikTok video `FILE_UPLOAD`; do not bypass explicit approval/confirmation.
- Verify Instagram can fetch the media URL and that the signed URL remains valid throughout its processing window.
- Perform a controlled test against a non-production social account only after explicit operator approval; no live post is authorized by this code change.
- Verify production API configuration and Storage bucket access without printing secrets.
- Do not merge or deploy until provider-specific blockers are resolved and the operator has reviewed the PR.

## Out of scope

- Making the bucket public.
- Changing production secrets, Storage policies, database schema, or migrations.
- Publishing any content to external platforms.
- Automatically retrying failed publication runs or rebinding them to different affiliate offers.
