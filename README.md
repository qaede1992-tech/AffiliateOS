# AffiliateOS

AffiliateOS is a TypeScript monorepo foundation for operating compliant affiliate programs across marketplaces. It keeps the current affiliate, offer, conversion, and commission workflows while adding provider-based product, campaign, content, social distribution, attribution, and analytics workflows.

## Architecture

- **`apps/web`** — React/Vite operations dashboard for the persisted API workflows.
- **`apps/api`** — Fastify API, domain services, validation, and Drizzle/PostgreSQL persistence.
- **`packages/shared`** — API/domain contracts shared by the dashboard and API.
- **Marketplace integrations** implement `MarketplaceProvider` (`discoverProducts`, `getProduct`, `searchProducts`, `getOffers`, `generateAffiliateLink`, and `syncConversions`) and are registered explicitly. The included `MockMarketplaceProvider` is test-only; no unofficial marketplace API is assumed.
- **Social integrations** implement `SocialMediaProvider` (`connect`, `publish`, `schedule`, `getPostStatus`, and `getMetrics`). The included mock never posts externally.
- **Content generation** is behind `ContentGenerator`. The safe template implementation uses supplied product fields only and deliberately avoids unsupported product claims. A production AI adapter should be configured separately.

## Current operational flow

The implemented application path is:

**Marketplace connection → Product → Affiliate Offer → Campaign → Tracking Link → Click → Conversion Attribution → Revenue/Commission Analytics**

Content and social workflow is available alongside the campaign flow:

**Campaign → Content → Social Account → OAuth state/callback foundation**

Attribution is explicit: AffiliateOS does not infer a conversion's tracking link from unrelated fields. Rejected conversions are excluded from attributed conversion, revenue, and commission analytics.

## Local development

Requirements: Node.js 24+, npm 11+, and PostgreSQL 16+ (or Docker Compose).

```bash
cp .env.example .env
npm install
docker compose up -d postgres
docker compose ps                 # wait until postgres is healthy
npm run db:verify                 # check assets, migrate, then inspect PostgreSQL
npm run dev
```

The web app uses Vite's default port; the API listens on `http://localhost:3001`. The production API uses PostgreSQL. Tests inject in-memory repositories, so the ordinary unit-test suite does not require a database.

## Database and migrations

Drizzle schema lives at `apps/api/src/db/schema.ts`; immutable SQL history and its journal live in `apps/api/drizzle/`. `DATABASE_URL` must be a `postgres://` or `postgresql://` URL; the local default in `.env.example` matches the Compose service.

```bash
npm run db:check     # validates SQL files, journal ordering, and foundation coverage; no database needed
npm run db:migrate   # applies tracked migrations to DATABASE_URL
npm run db:verify    # runs db:check, migrates, and verifies tables/indexes/the Drizzle ledger
npm run db:generate  # generates a candidate migration after a deliberate schema change
```

`db:verify` is the recommended local smoke test against a running, disposable PostgreSQL database. It is safe to re-run: Drizzle records applied migrations in `__drizzle_migrations`, and the migrations are additive. Do **not** edit a migration that may already have been applied; add a new, sequential migration and journal entry instead.

`0000_initial` owns the original `affiliates`, `offers`, `conversions`, and `commissions` tables. `0001_affiliateos_foundation` adds marketplaces, affiliate accounts, products, affiliate offers, campaigns, campaign offers, tracking links/clicks, social accounts, and content. `0002_tracking_links_campaign_index` supplies the `tracking_links_campaign_idx` index declared by the Drizzle schema but absent from `0001`. Later migrations add durable OAuth state and explicit conversion attribution. Amounts are integer minor units (`*_cents`); commission rates use basis points. Credentials are represented only as `credential_reference` fields—never secret values.

## API

All application endpoints are under `/api/v1`. The API includes:

- affiliate, offer, conversion, and commission resources
- marketplace provider discovery, connection lifecycle, health checks, product discovery/search, offers, and affiliate-link generation
- product opportunity scoring
- campaign and campaign-offer lifecycle
- tracking-link creation/listing, click recording, and link statistics
- explicit conversion attribution
- database-backed analytics overview and campaign analytics
- content creation/listing/update
- social-account registration/update and OAuth start/callback state handling
- liveness check at `GET /api/v1/health`
- dependency readiness check at `GET /api/v1/ready` (production wiring verifies PostgreSQL)

The product-opportunity score accepts optional `commissionRateBps` and `audienceRelevance` (0–1), and returns transparent score reasons. The score is a prioritisation signal, **not a sales forecast or guarantee**.

## Configuration and credentials

Marketplace Connections are configuration records, not a claim that an external marketplace is connected. `POST /api/v1/marketplaces` creates a disabled or unverified record; `POST /api/v1/marketplaces/:connectionSlug/test` is the operation that can mark a test-capable provider healthy. The API returns `hasCredentialReference`, never the reference itself, and the dashboard never renders credential references. Mock providers are labelled **tests only** and cannot represent a live connection.

To add a future **official** adapter, implement `MarketplaceProvider` in `apps/api/src/domain/`, set `connectionMode: "official_api"`, declare only the capabilities actually supported, validate only non-secret configuration, and implement `testConnection` only when the official API has a safe verification operation. Register the adapter during production service composition in `apps/api/src/server.ts` (or a dedicated provider bootstrap). Supply an opaque secret-manager locator such as `vault://affiliateos/marketplace/acme` in `credentialReference`; have the adapter resolve it at runtime through deployment infrastructure, never from PostgreSQL metadata or the dashboard. Do not register a provider for a marketplace until its official API agreement, scopes, and credential flow have been approved.

Connection `configuration` rejects secret-like fields (`token`, `secret`, `password`, `apiKey`, and similar). Keep region, account identifiers, API version, and other non-sensitive adapter settings there. Failed health checks persist a redacted diagnostic only; API/request logging redacts credential and configuration fields.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (required by API runtime). |
| `API_HOST`, `API_PORT` | API listener settings. |
| `API_CORS_ORIGIN` | Explicit deployed dashboard origin; local default is `http://localhost:5173`. |
| `VITE_API_URL` | Dashboard API base URL for development/proxy configuration. |
| `AFFILIATEOS_MARKETPLACE_*_CREDENTIAL_REF` | Optional deployment-level reference to a secret-manager entry; adapters resolve it at runtime. |
| `AFFILIATEOS_SOCIAL_*_CREDENTIAL_REF` | Optional OAuth/API credential reference for an approved social adapter. |
| `AFFILIATEOS_AI_*_CREDENTIAL_REF` | Optional credential reference for a production content-generator adapter. |

Do not put API keys, OAuth tokens, or marketplace credentials in `.env.example`, source code, migrations, or database metadata JSON. Production adapters must use the official OAuth/API scopes and consent flows of their platforms; AffiliateOS intentionally does not scrape marketplaces, create accounts, or post automatically without authorization.

## HTTP runtime hardening

The API supports an explicit CORS origin, limits request bodies to 1 MiB, redacts sensitive credential/configuration request fields from logs, and preserves appropriate client-error status codes such as `413` for oversized request bodies. `GET /api/v1/ready` performs the production database dependency check and returns `503` when PostgreSQL is unavailable.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run db:check
```

CI validates tests, typechecking, production builds, and migration checks. HTTP regression coverage includes configured CORS behavior, the 1 MiB request-body limit, and readiness failure handling.

## Production completion checklist

The codebase is intentionally provider-neutral where external authorization is required. Before a live deployment, complete the environment-specific operational controls below:

1. Configure an authenticated application/session layer appropriate for the deployment and protect administrative API operations.
2. Register only approved marketplace/social providers with their official credentials, scopes, terms, and secret-manager integration.
3. Configure the deployed dashboard origin through `API_CORS_ORIGIN` and use TLS at the edge.
4. Use a managed PostgreSQL deployment with backups, retention, monitoring, and migration promotion controls.
5. Add deployment-specific rate limiting, request tracing/metrics, alerting, and log retention at the edge/platform layer.
6. Run `npm run db:verify` against the release database before enabling traffic and retain migration/audit records.

These items depend on the target deployment environment and external provider approvals; the repository does not fabricate credentials or pretend that an external integration is live.

## Roadmap

The application/domain foundation and database-backed operational workflow are implemented. Remaining work is deployment-specific rather than a new core domain rewrite:

- approved official marketplace adapters when credentials/API agreements are available
- approved social publishing adapters and production OAuth credential exchange
- secret-manager integration supplied by deployment infrastructure
- production authentication/session/authorization policy and infrastructure-level rate limiting/observability
- deployment manifests, managed database operations, backups, and release automation for the target hosting environment
