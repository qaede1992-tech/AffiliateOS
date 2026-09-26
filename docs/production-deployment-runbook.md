# Production deployment runbook

This runbook converts the AffiliateOS release candidate into a controlled production deployment without inventing cloud, secret-manager, marketplace, social, or identity-provider details.

## Release gate

Run the **Production Release Candidate** GitHub Actions workflow against the intended commit or release tag. Proceed only when validation, migration checks, API container smoke, web container smoke, and the release gate are successful.

Record the commit SHA, workflow run, migration verification result, and deployment image digests.

## Required deployment inputs

Provide these through the deployment platform's approved configuration/secret mechanisms:

- DATABASE_URL: managed PostgreSQL URL.
- API_AUTH_TOKEN: secret of at least 32 characters.
- API_AUTH_OPERATOR_ID: initial operator identity.
- API_AUTH_OPERATOR_ROLE: admin, operator, or viewer.
- API_CORS_ORIGIN: exact HTTPS dashboard origin.
- VITE_API_URL: public API origin embedded into the web build; never a credential.
- Marketplace/social/AI credential references: secret-manager references for approved official adapters.

Never put credential values in source, migrations, Docker build arguments, database metadata, or .env.example.

## Infrastructure controls

Before traffic is enabled, the deployment environment must provide:

1. TLS and certificate renewal at the edge.
2. Managed PostgreSQL backups, retention, restore testing, monitoring, and restricted access.
3. A controlled migration process that applies checked-in Drizzle migrations once per release.
4. A shared or edge rate limiter when multiple API instances are deployed.
5. Centralized redacted logs and appropriate retention.
6. Metrics, tracing, readiness/error alerting, and uptime monitoring.
7. Restricted API-to-database network access.
8. A documented application rollback and separate database migration rollback/forward-fix strategy.

The repository's in-memory rate limiter and CI smoke tests do not provide distributed infrastructure guarantees.

## Database promotion

Use staging/disposable PostgreSQL first.

1. Run `npm run db:check`.
2. Apply release migrations through the deployment migration process.
3. Run `npm run db:verify:applied`.
4. Confirm the migration journal matches the release.
5. Preserve migration/audit records.
6. Never edit an already-applied migration; add a new sequential migration.

Do not use `db:verify` on a production database when deployment policy forbids a verification command that also applies migrations.

## API rollout

Start with NODE_ENV=production, the production database URL, the production auth secret, the exact dashboard CORS origin, and the approved operator identity/role.

Keep autonomous execution disabled until approved provider integrations are validated.

Verify:

- `GET /api/v1/health` is live.
- `GET /api/v1/ready` reports PostgreSQL readiness.
- unauthenticated application requests are rejected.
- authenticated operator access works.
- session cookies are HttpOnly and SameSite=Strict.
- the expected CORS origin is allowed and an unexpected origin is rejected.
- security headers are present.
- the container healthcheck is healthy.

The release workflow already exercises these API checks against a production-mode container.

## Web rollout

Build with the deployed API origin:

```bash
docker build --file apps/web/Dockerfile \
  --build-arg VITE_API_URL=https://<deployed-api-origin> \
  --tag affiliateos-web:<release> .
```

The placeholder is intentionally not a real endpoint. Replace it only in the deployment environment.

Verify /healthz, the application root, web security headers, browser API targeting, and that no credential/bearer token is embedded in the bundle.

## Provider activation

For every marketplace or social provider:

1. Use the provider's official API/OAuth flow.
2. Approve only required scopes and terms.
3. Store credentials only in the secret manager.
4. Store only credential references in AffiliateOS configuration.
5. Test connection health.
6. Test product/offer discovery and affiliate-link generation.
7. Test signed provider events where enabled.
8. Keep autonomous execution disabled until the end-to-end flow is validated.

Mock providers are tests-only and must never be treated as production integrations.

## Shopee conversion synchronization gate

Shopee conversion-report synchronization is disabled by default. Enable it only after:

1. the official Shopee Affiliate credentials are present through the approved secret manager;
2. the Shopee connection passes its health check and is active;
3. the marketplace account is bound to the intended AffiliateOS affiliate;
4. affiliate links and account-scoped tracking references are tested;
5. conversion-report reconciliation has been tested with provider data, including repeated reports, late status changes, and unattributed reports;
6. the production PostgreSQL advisory-lock behavior has been verified across multiple API replicas.

When enabled, use `SHOPEE_CONVERSION_SYNC_INTERVAL_MS` at or above five minutes and a bounded `SHOPEE_CONVERSION_SYNC_LOOKBACK_HOURS` (maximum 31 days). The scheduler reconciles a rolling window so provider status changes can be picked up; repeated provider reports are handled through conversion idempotency. Keep the scheduler disabled if provider credentials or attribution are not yet validated.

## Autonomous execution gate

Enable AUTONOMOUS_CYCLE_ENABLED=true only after:

- an approved marketplace connection discovers executable offers;
- affiliate links are active;
- approved publication accounts/adapters pass readiness;
- attribution and provider conversion events have been tested;
- retry/recovery behavior has been exercised;
- monitoring and alerting are active.

Keep AUTONOMOUS_CYCLE_INTERVAL_MS at or above five minutes. After activation, verify autonomous status and cross-instance single-cycle behavior.

## Rollout and rollback

Use staged rollout:

1. deploy API and web without autonomous execution;
2. run health/readiness/authenticated smoke checks;
3. enable normal traffic;
4. observe errors, latency, database health, publication jobs, provider events, and attribution;
5. activate approved providers;
6. enable autonomous execution last;
7. review initial autonomous cycles before expanding scope.

Application rollback should redeploy a previously validated image. Database rollback is separate; do not assume an application image rollback can undo a schema migration.

## Release record

Retain the release tag/SHA, CI run, image digests, migration state, deployment timestamp, activation approver, provider credential-reference changes, autonomous enablement state, and rollback target.

The repository intentionally contains no real production credentials or environment-specific deployment identifiers.
