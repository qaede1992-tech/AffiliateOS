# AffiliateOS

AffiliateOS is a TypeScript monorepo foundation for operating compliant affiliate programs across marketplaces. It keeps the current affiliate, offer, conversion, and commission workflows while adding provider-based product, campaign, content, social distribution, attribution, and analytics workflows.

## Architecture

- **`apps/web`** — React/Vite operations dashboard for the persisted API workflows.
- **`apps/api`** — Fastify API, domain services, validation, authentication/authorization, and Drizzle/PostgreSQL persistence.
- **`packages/shared`** — API/domain contracts shared by the dashboard and API.
- Marketplace integrations implement `MarketplaceProvider` and are registered explicitly. The included `MockMarketplaceProvider` is test-only; no unofficial marketplace API is assumed.
- Social integrations implement `SocialMediaProvider`. The included mock never posts externally.
- Content generation is behind `ContentGenerator`. The safe template implementation uses supplied product fields only and deliberately avoids unsupported product claims.

## Current operational flow

The implemented application path is:

**Marketplace connection → Product → Affiliate Offer → Campaign → Tracking Link → Click → Conversion Attribution → Revenue/Commission Analytics**

Autonomous execution is available as an operational layer:

**Enabled Marketplace Connections → Product Discovery → Executable Affiliate Offers → Opportunity Scoring → Autonomous Campaign/Content Creation → Scheduled Publication → Attribution/Analytics → Performance Feedback → Retry/Recovery**

Autonomous runs are idempotent and durable. Failed work uses bounded exponential backoff, stale processing is recoverable, and exhausted runs can be manually reset by an authorized operator. Operator endpoints expose run status without exposing credentials.

Content and social workflow is available alongside the campaign flow:

**Campaign → Content → Social Account → OAuth state/callback foundation**

Attribution is explicit: AffiliateOS does not infer a conversion's tracking link from unrelated fields. Rejected conversions are excluded from attributed conversion, revenue, and commission analytics.

## Local development

Requirements: Node.js 24+, npm 11+, and PostgreSQL 16+ (or Docker Compose).

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:verify
npm run dev
```

The web app uses Vite's default port; the API listens on `http://localhost:3001`. The production API uses PostgreSQL. Tests inject in-memory repositories, so the ordinary unit-test suite does not require a database.

## Production web build

The production web image requires the API origin at build time because Vite embeds `VITE_API_URL` into the browser bundle. Build it explicitly, for example:

```bash
docker build --file apps/web/Dockerfile --build-arg VITE_API_URL=https://api.example.com --tag affiliateos-web:release .
```

Use the same origin as the deployed API and configure the API's `API_CORS_ORIGIN` to the deployed dashboard origin. Do not put credentials or tokens in `VITE_API_URL`; it is public browser configuration.

## Database and migrations

Drizzle schema lives at `apps/api/src/db/schema.ts`; immutable SQL history and its journal live in `apps/api/drizzle/`. `DATABASE_URL` must be a `postgres://` or `postgresql://` URL; the local default in `.env.example` matches the Compose service.

```bash
npm run db:check
npm run db:migrate
npm run db:verify
npm run db:verify:applied
npm run db:generate
```

`db:verify` is the recommended local smoke test against a running, disposable PostgreSQL database because it applies migrations before verification. For a release database that must not be mutated by the verification step, use `npm run db:verify:applied` after the release migration has been applied. Do **not** edit a migration that may already have been applied; add a new, sequential migration and journal entry instead.

## API

All application endpoints are under `/api/v1`. The API includes affiliate, offer, conversion, commission, marketplace, campaign, tracking, attribution, analytics, content, social-account, and OAuth workflows plus liveness/readiness endpoints.

`GET /api/v1/health` and `GET /api/v1/ready` are intentionally unauthenticated operational endpoints. `GET /api/v1/autonomous/status`, `GET /api/v1/autonomous/runs`, and `GET /api/v1/autonomous/runs/:runId` provide authenticated operational visibility; autonomous run recovery and manual retry require an `admin` or `operator` role. Application endpoints require authentication when the production runtime is enabled. `GET /api/v1/auth/me` returns the authenticated operator context without returning the bearer credential.

### Authentication and authorization

Production API authentication uses a bearer token configured through `API_AUTH_TOKEN`. The token is compared using a constant-time comparison and is never logged. `API_AUTH_OPERATOR_ID` supplies the authenticated operator identity and `API_AUTH_OPERATOR_ROLE` supplies its role (`admin`, `operator`, or `viewer`). Marketplace activation additionally requires an `admin` or `operator` role.

Browser sessions use an HttpOnly, SameSite session cookie established through `/api/v1/auth/login`. Session-authenticated state-changing requests are bound to the configured dashboard `Origin`; bearer-authenticated API clients remain supported. The browser dashboard never stores the bearer credential.

This remains a single-operator authentication foundation, not a complete multi-user identity product. The deployment must eventually replace the configured operator credential with its approved identity provider/session mechanism if multiple users, account lifecycle, MFA, passwordless login, or organization-level permissions are required.

For local development, authentication remains disabled when no token is configured and `NODE_ENV` is not `production`, preserving the in-memory development/test workflow. A production process refuses to start without `API_AUTH_TOKEN`.

## Configuration and credentials

Marketplace Connections are configuration records, not a claim that an external marketplace is connected. New connections are inactive; `/api/v1/marketplaces/:connectionSlug/enabled` requires explicit confirmation and an authorized operator before activation. The API returns `hasCredentialReference`, never the reference itself, and the dashboard never renders credential references. Mock providers are labelled **tests only** and cannot represent a live connection.

Connection `configuration` rejects secret-like fields. Failed health checks persist a redacted diagnostic only; API/request logging redacts credential, configuration, authorization, and OAuth callback fields.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. |
| `API_HOST`, `API_PORT` | API listener settings. |
| `API_CORS_ORIGIN` | Explicit deployed dashboard origin. |
| `VITE_API_URL` | Public dashboard API base URL, embedded at web build time. |
| `API_AUTH_TOKEN` | Production bearer credential; store only in a secret manager. |
| `API_AUTH_OPERATOR_ID` | Server-side operator identity attached to the authenticated credential. |
| `API_AUTH_OPERATOR_ROLE` | Server-side role: `admin`, `operator`, or `viewer`. |
| `API_RATE_LIMIT_MAX` | Maximum application requests per client IP in one rate-limit window. |
| `API_RATE_LIMIT_WINDOW_MS` | Rate-limit window length in milliseconds. |
| `AFFILIATEOS_MARKETPLACE_*_CREDENTIAL_REF` | Deployment-level reference to a secret-manager entry. |
| `AFFILIATEOS_SOCIAL_*_CREDENTIAL_REF` | Optional OAuth/API credential reference for an approved social adapter. |
| `SOCIAL_CREDENTIALS_JSON` | Deployment-injected secret payload mapping opaque social credential references to runtime access-token records; source control and database must contain no token values. |
| `AFFILIATEOS_AI_*_CREDENTIAL_REF` | Optional credential reference for a production content-generator adapter. |
| `AUTONOMOUS_CYCLE_ENABLED` | Enables the autonomous discovery/selection/execution scheduler; keep disabled until approved provider connections are configured. |
| `AUTONOMOUS_CYCLE_INTERVAL_MS` | Autonomous cycle interval; minimum 5 minutes, default 15 minutes. |

Do not put API keys, OAuth tokens, marketplace credentials, or bearer credentials in `.env.example`, source code, migrations, or database metadata JSON. Production adapters must use official OAuth/API scopes and consent flows.

## HTTP runtime hardening

The API supports explicit CORS, a 1 MiB request-body limit, sensitive request-log redaction, authenticated application endpoints in production, browser session authentication, a configurable in-memory application rate limiter, and a database dependency readiness check returning `503` when PostgreSQL is unavailable. Rate limiting is disabled by default in development unless configured, and defaults to 120 application requests per client IP per 60 seconds in production. Health and readiness endpoints are excluded so infrastructure probes remain available.

The built-in limiter is process-local. Deployments with multiple API instances should use an external/shared rate-limit store or an edge/API-gateway limiter for global enforcement.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run db:check
```

CI validates tests, typechecking, production builds, migration checks, and production container smoke tests. HTTP regression coverage includes CORS behavior, the request-body limit, readiness handling, authentication, browser sessions, operator authorization, and rate limiting.

## Production release artifacts

The repository includes a tag-based release workflow at `.github/workflows/release.yml`. A release tag must exactly match the root `package.json` version (for example, `v0.1.0` for version `0.1.0`).

Before creating a production tag:

1. Configure the GitHub repository variable `PRODUCTION_API_URL` with the public HTTPS origin of the deployed API. This is build-time browser configuration, not a secret.
2. Confirm the target deployment has its runtime secrets in the approved secret manager; do not place them in GitHub repository variables, source control, or image build arguments.
3. Apply and verify the release database migrations using the controlled production migration process.
4. Create the matching version tag and push it to GitHub. The release workflow builds and publishes API/web images to GHCR under both the release tag and commit SHA, with provenance and SBOM attestations, then creates the GitHub release.
5. Deploy the exact published image digests through the deployment platform. Run health/readiness checks and `npm run db:verify:applied` before enabling traffic.
6. Keep `AUTONOMOUS_CYCLE_ENABLED=false` until the approved Shopee and social credentials/providers have been configured and production preflight passes.

The release workflow does not configure marketplace/social credentials or deploy them automatically; provider activation remains an explicit deployment responsibility.

## Production completion checklist

1. Replace the configured single-operator credential with the target deployment's approved identity provider/session mechanism when multiple users or richer account lifecycle is required.
2. Register only approved marketplace/social providers with official credentials, scopes, terms, and secret-manager integration.
3. Build the dashboard with the deployed API origin via `VITE_API_URL`, configure `API_CORS_ORIGIN` with the dashboard origin, and use TLS at the edge.
4. Use managed PostgreSQL with backups, retention, monitoring, and migration promotion controls.
5. Use a shared/edge rate limiter for multi-instance deployments and add deployment-specific tracing/metrics, alerting, and log retention.
6. Apply the release migrations under the deployment's controlled migration process, then run `npm run db:verify:applied` against the release database before enabling traffic and retain migration/audit records.

The repository does not fabricate credentials or pretend that an external integration is live.
