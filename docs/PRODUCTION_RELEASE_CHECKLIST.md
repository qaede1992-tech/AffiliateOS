# Production Release Checklist

Use this checklist for every production release of AffiliateOS.

## Application

- [ ] Production `API_CORS_ORIGIN` is configured to the deployed HTTPS dashboard origin.
- [ ] `VITE_API_URL` points to the deployed API origin.
- [ ] `API_AUTH_TOKEN` is stored in a production secret manager and is at least 32 characters.
- [ ] Production TLS is terminated and enforced by the deployment infrastructure.
- [ ] Marketplace/social provider credentials and scopes are configured through approved production secret management.
- [ ] If Shopee conversion sync is enabled, `SHOPEE_CONVERSION_SYNC_ENABLED=true`, its interval is at least 5 minutes, and provider credentials/attribution have passed end-to-end validation.

## Database

- [ ] Production PostgreSQL backups, retention, and monitoring are enabled.
- [ ] Migration promotion/rollback procedures are defined by the deployment platform.
- [ ] `npm run db:verify:applied` passes against the release database before promotion without applying new migrations.

## Runtime

- [ ] API container health endpoint reports healthy.
- [ ] Web container `/healthz` reports healthy.
- [ ] API readiness can reach PostgreSQL.
- [ ] Container images run as intended with production environment variables.

## Security and operations

- [ ] Production rate limiting is appropriate for the deployment topology; shared/edge limiting is used when multiple API replicas are deployed.
- [ ] Centralized logs, retention, alerting, and deployment tracing/metrics are configured by infrastructure.
- [ ] Release audit records include the deployed commit SHA and migration state.

## Shopee conversion synchronization

- [ ] Keep `SHOPEE_CONVERSION_SYNC_ENABLED=false` until the Shopee connection is healthy, affiliate-account binding is valid, affiliate links are active, and conversion attribution has been tested.
- [ ] When enabled, verify the rolling lookback is appropriate for late provider status changes and the sync scheduler reports successful cycles.
- [ ] Verify only one production API instance performs each sync cycle through the PostgreSQL advisory lock; repeated provider reports must remain idempotent.

## Release evidence

- [ ] CI test, typecheck, build, migration verification, container build, and runtime smoke tests are green for the exact release commit.
- [ ] The release candidate tag has passed the repository release workflow and immutable API/web image digests have been recorded.
- [ ] The exact release images have been promoted to production and production deployment has been smoke-tested.
- [ ] The deployed commit SHA is recorded with the release.

## Release procedure

1. Start from a clean `main` commit with all required CI checks green and record its exact SHA.
2. Create the matching release tag so the release workflow can build and publish immutable API/web images for that exact commit.
3. Run `npm run db:verify:applied` against the release database before promotion; this verifies migration state without applying new migrations.
4. Promote the exact immutable API and web image digests produced by the release workflow.
5. Confirm API health and readiness, then confirm the web `/healthz` endpoint.
6. Run the documented production smoke tests against the deployed origins and record the deployment evidence.
7. After production evidence is complete, approve the `production-release` GitHub Environment so the workflow creates the GitHub Release and uploads `release-images.txt`.
8. Record the deployed commit SHA, image digests, migration state, and approval in the release record.

The checklist is evidence-driven: a repository CI pass validates the application and images, while deployment-specific items must be verified in the production environment before a release is declared complete.
