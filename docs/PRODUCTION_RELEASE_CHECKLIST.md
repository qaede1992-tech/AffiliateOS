# Production Release Checklist

Use this checklist for every production release of AffiliateOS.

## Application

- [ ] Production `API_CORS_ORIGIN` is configured to the deployed HTTPS dashboard origin.
- [ ] `VITE_API_URL` points to the deployed API origin.
- [ ] `API_AUTH_TOKEN` is stored in a production secret manager and is at least 32 characters.
- [ ] Production TLS is terminated and enforced by the deployment infrastructure.
- [ ] Marketplace/social provider credentials and scopes are configured through approved production secret management.

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

## Release evidence

- [ ] CI test, typecheck, build, migration verification, container build, and runtime smoke tests are green for the exact release commit.
- [ ] Production deployment has been smoke-tested after promotion.
- [ ] The deployed commit SHA is recorded with the release.

## Release procedure

1. Start from a clean `main` commit with all required CI checks green.
2. Record the exact commit SHA as the release candidate.
3. Run `npm run db:verify:applied` against the release database before promotion; this verifies migration state without applying new migrations.
4. Promote the API and web images built from the exact release commit.
5. Confirm API health and readiness, then confirm the web `/healthz` endpoint.
6. Run the documented production smoke tests against the deployed origins.
7. Record the deployed commit SHA and migration state in the release record.
8. Create the GitHub Release only after the deployment evidence is complete.

The checklist is evidence-driven: a repository CI pass validates the application and images, while deployment-specific items must be verified in the production environment before a release is declared complete.
