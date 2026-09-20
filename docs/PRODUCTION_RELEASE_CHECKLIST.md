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
- [ ] `npm run db:verify` passes against the release database before promotion.

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
