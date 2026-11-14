# Product Media Rights Verification

## Status and scope

This document defines the next implementation boundary for the product-media rights fields introduced by migration `0071_product_media_rights_provenance`. It is a design specification only: it does not change application behavior, database state, credentials, storage objects, deployments, or publication settings.

The system must fail closed. A stored or generated media file is not evidence that AffiliateOS has permission to publish it. An HTTPS evidence URL is a reference for a human review, not proof by itself.

## Required invariants

1. Every ingested or generated asset starts as `unverified`.
2. Only an authenticated `admin` may verify or revoke media rights. The current API authentication model supplies one configured operator role; the route must reject `operator` and `viewer` roles rather than treating all write-capable users as reviewers.
3. Verification is an explicit human attestation after inspecting the actual evidence and confirming that it covers the exact asset, publisher, intended commercial use, media formats, territories, platforms, and validity period relevant to the planned publication.
4. A URL, a publisher name, successful download, product-page visibility, or a generated derivative alone never changes an asset to `verified`.
5. Every verify/revoke action creates an append-only audit record containing the asset ID, actor ID, actor role, action, prior and resulting state, basis, evidence reference, reason, and timestamp. Never log access tokens, secrets, or evidence contents.
6. Revocation immediately removes the asset from all publishable-media queries. A later re-verification is a new audited action; it must not erase the revocation history.
7. A cached selection or preview is never sufficient authorization to publish. Rights must be re-read at the last responsible moment on the actual publication path.
8. The API must not fetch arbitrary evidence URLs to validate them. That would create an SSRF surface and still would not establish legal permission. Evidence inspection is performed by the authorized reviewer outside the server's network trust boundary.

## State transitions

Allowed transitions:

- `unverified -> verified`: admin supplies a supported rights basis, HTTPS evidence reference, publisher/source identity, and a meaningful review reason; the service records reviewer and server-generated verification time.
- `unverified -> revoked`: admin records why the asset is prohibited or unusable; this is allowed to preserve a durable decision.
- `verified -> revoked`: admin records a revocation reason; publication eligibility is removed immediately.
- `revoked -> verified`: only after a fresh review of current evidence; record a new audit event and new verification time.

No public, operator, viewer, ingestion, renderer, discovery, or autonomous-cycle endpoint may set a rights status.

## Evidence and basis policy

Supported bases remain the schema enum:

- `explicit_permission`: written permission from the rights holder or an authorized representative.
- `license`: a license whose terms cover the intended use and distribution.
- `public_domain`: a defensible public-domain basis for the specific work and relevant jurisdiction.
- `user_owned`: the user confirms ownership and authority to grant the intended use.
- `platform_authorization`: platform-provided authorization that expressly covers the intended reuse.

A reviewer must not select a basis merely because it is the closest option. If the evidence does not fit a supported basis, leave the asset unverified and add a future schema value only through a separately reviewed migration.

The evidence reference should point to a durable, access-controlled record or authoritative source. Avoid placing private signed URLs or confidential permission documents in ordinary logs. If a private evidence store is introduced, persist a non-secret reference to it, not a bearer URL.

## API contract for implementation

The implementation should add admin-only endpoints with strict Zod validation:

- `GET /api/v1/product-media-assets?rightsStatus=unverified`: paginated review queue; return metadata needed to identify the asset and product, but never return private storage credentials or signed download URLs.
- `POST /api/v1/product-media-assets/:assetId/rights/verify`: require `rightsBasis`, `rightsEvidenceUrl`, `sourcePublisher`, and a non-empty reviewer reason. The server supplies actor ID, role, and timestamp.
- `POST /api/v1/product-media-assets/:assetId/rights/revoke`: require a non-empty reason; preserve prior provenance and append an audit event.

The service must reject malformed/non-HTTPS evidence references, evidence URLs containing embedded username/password credentials, unsupported bases, missing publisher identity, empty reasons, unknown assets, and attempts by non-admin roles. It must not accept `rightsVerifiedAt`, `actorId`, or `rightsStatus` from the request body; those are server-controlled.

Use optimistic concurrency or a transaction that locks the asset row while changing its status and inserting the audit event. If either write fails, neither should commit. Audit rows are append-only to the application role; no update/delete route should exist.

## Authorization constraint in the current application

`AuthContext` currently contains `operatorId` and one configured role (`admin | operator | viewer`). It is not a multi-user identity/role system. The first implementation can safely gate the endpoints on `request.auth.role === "admin"`, with actor ID taken from `request.auth.operatorId`. Do not imply that this is per-user RBAC. A future multi-user identity system must bind the actor ID and role to a verified principal before exposing reviewer permissions.

## Publication gate requirements

- Keep readiness checks separate from rights checks so an unverified generated video does not cause endless re-rendering.
- Only assets with `rightsStatus = verified`, a supported basis, HTTPS evidence reference without embedded credentials, non-empty publisher identity, and a valid server-generated verification timestamp that is not in the future are publishable.
- Image and video checks must use the same provenance predicate.
- Re-check current rights when selecting a product, but treat this as an early eligibility check only; it does not authorize a later publication by itself.
- The actual publisher/worker must resolve the content's product and exact media asset IDs, then re-read the current rights state immediately before handing media to the platform provider. A scheduled job, retry, or recovered run must perform this check again rather than relying on the state captured when the job was created.
- The current implementation adds this last-mile check to `PublisherExecutor.execute`: product-scoped object-storage media must match exactly one persisted `product_media_assets` row by product ID, bucket, and object key, with current verified provenance. Missing repositories, missing/duplicate matches, unlinked products, unverified/revoked rights, and all externally hosted URL media fail closed, whether or not the content has linked products. The primary `content.productId` and story-linked products are both included in the allowed product scope.
- Content-scoped uploads under `content/<contentId>/` are a separate owner-upload pathway and are not represented by `product_media_assets`; this product-media gate does not establish rights for those uploads. A separate content-upload ownership/rights policy remains necessary before claiming that every possible media source is rights-verified.
- If the rights lookup fails, the asset is missing, the media-to-product association is ambiguous, or any asset is unverified/revoked, block the entire affected publication before any provider upload/post request. Do not silently fall back to a cached URL, a legacy media record, or a caller-supplied product ID.
- Revocation must block subsequent provider dispatches for both images and videos, including already queued jobs. A request already accepted by an external platform cannot reliably be recalled by this gate; record that boundary and surface the in-flight publication state for operator action.
- Do not inherit source-media rights onto rendered videos. A derivative may require its own rights review for source footage, music, trademarks, and other incorporated material.

## Required automated tests

- unauthenticated requests receive 401; viewer/operator receive 403; admin can access the review queue and submit valid decisions.
- request bodies cannot spoof actor, role, timestamp, or status.
- each invalid/missing evidence field and empty reason is rejected.
- verification creates exactly one audit event and sets server timestamp/actor.
- revocation removes an asset from publishable image and video sets immediately.
- re-verification after revocation creates a new event without deleting earlier events.
- concurrent verify/revoke attempts cannot leave state and audit history inconsistent.
- audit history has no application update/delete path.
- publication preview and final selection both fail closed after revocation.
- a scheduled job created while rights were verified is blocked if rights are revoked before provider dispatch.
- retries and recovered autonomous runs re-read rights; lookup failures fail closed.
- ambiguous or missing media-to-product associations block publication.
- a revocation racing with dispatch is handled consistently and its in-flight boundary is auditable.

## Rollout boundaries

This workflow must be delivered behind tests and migration checks in a separate reviewed PR. Do not apply migrations to production or staging, change RLS/privileges, deploy, enable autonomous publication, or publish content as part of implementation. The owner must review and approve the PR before merge or deployment.


## Repository implementation findings (2026-11-02)

- `writeGuard` delegates to `requireOperator`, which is broader than rights-review permission. Each rights endpoint must therefore add an explicit `request.auth?.role === "admin"` check and return 403 otherwise; relying on `writeGuard` alone is insufficient.
- The configured authentication context contains one `operatorId` and one configured role. The audit actor is that configured operator ID, not a claim of independently verified human identity or multi-user RBAC.
- The existing `TransactionManager` is deliberately narrow: its generic transaction callback currently exposes conversion and commission repositories, while marketplace import has a separate transaction method. Do not widen either unrelated workflow merely to implement media rights.
- Implement a focused `ProductMediaRightsWorkflow` repository/service boundary, backed by the actual Drizzle database transaction in the DB composition layer. Its verify/revoke operation must lock the `product_media_assets` row, validate the current state, update provenance, and insert the audit event in one transaction. A missing asset, invalid transition, or failed audit insert must roll back the entire operation.
- Keep the audit repository separate from the mutable media-asset repository. The application runtime needs only the permissions required to read and append audit events; it must have no update/delete path for audit rows. The migration must enable RLS and follow the existing private-table privilege pattern, with no grants to `public`, `anon`, or `authenticated`.
- The service should return the updated asset and newly inserted audit event only after transaction commit. HTTP handlers must not construct actor IDs or timestamps from request data.
- The current `PublisherExecutor.execute()` performs the product-media rights lookup after resolving credentials and immediately before `publisher.publish()`. `PublicationWorker` routes scheduled jobs, retries, and stale-processing recovery through this method. Worker reconciliation of already accepted provider operations calls `PublisherExecutor.check()` and does not initiate a new provider media upload; it must not be mistaken for a fresh dispatch path.
- The last-mile check is not a cancellation mechanism for provider operations already accepted externally. Revocation blocks future dispatch attempts; accepted/in-flight operations remain subject to reconciliation and manual platform-side action where available.

The migration and runtime workflow are intentionally not implemented by this documentation update. The prior attempt to create the audit migration was blocked by a safety check; do not work around that block or apply any schema change to staging or production. Resume implementation only through an allowed, separately reviewed change path.


## Content-scoped upload gap and interim publication policy (2026-11-02)

A code inspection of `MediaUploadService` and the `/api/v1/content/media-upload` route found that content-scoped uploads are stored under `content/<contentId>/...`, but the current `MediaAsset` record does not persist an uploader principal, ownership attestation, rights basis, evidence reference, or review timestamp. The route admits the configured `admin` or `operator` role, while the current authentication model represents one configured operator identity rather than a separately authenticated end-user. Therefore, the current implementation cannot substantiate a `user_owned` rights claim for these uploads.

Until a separate auditable content-media provenance workflow exists:

- Do not treat content-scoped uploads as automatically owner-authorized or rights-verified.
- Block content-scoped object-storage media from provider dispatch, even when the content has no linked affiliate product.
- Block externally hosted URL media from provider dispatch because it has no persisted rights provenance.
- Block unknown/legacy object-storage key namespaces rather than silently bypassing the product-media rights check.
- Keep product-scoped media eligible only through the exact-match, current verified provenance row already enforced by `PublisherExecutor.execute()`.

The implementation now applies this interim fail-closed policy in `assertProductMediaRightsForPublication`. Tests cover content-scoped media, unknown object-storage namespaces, and external URLs on content with no linked products. This intentionally may block existing manually uploaded content until the separate workflow is implemented; that is safer than treating upload capability as proof of publication rights.

A future content-media workflow should persist the uploader principal and an explicit rights declaration at upload time, keep ownership/permission evidence private, require admin review where the declaration is insufficient, append immutable audit events for changes, and re-check current status immediately before provider dispatch. The actor must be a verified principal; do not infer it from a broad `admin`/`operator` role or a client-supplied field.
