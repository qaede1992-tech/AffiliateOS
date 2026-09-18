# AffiliateOS

AffiliateOS is a TypeScript monorepo foundation for operating compliant affiliate programs across marketplaces. It keeps the current affiliate, offer, conversion, and commission workflows while adding a provider-based foundation for products, campaigns, content, social distribution, and analytics.

## Architecture

- **`apps/web`** — React/Vite operations dashboard. It reads the existing API resources and displays database-backed operational records.
- **`apps/api`** — Fastify API, domain services, validation, and Drizzle/PostgreSQL persistence.
- **`packages/shared`** — API/domain contracts shared by the dashboard and API.
- **Marketplace integrations** implement `MarketplaceProvider` (`discoverProducts`, `getProduct`, `searchProducts`, `getOffers`, `generateAffiliateLink`, and `syncConversions`) and are registered explicitly. The included `MockMarketplaceProvider` is test-only; no unofficial marketplace API is assumed.
- **Social integrations** implement `SocialMediaProvider` (`connect`, `publish`, `schedule`, `getPostStatus`, and `getMetrics`). The included mock never posts externally.
- **Content generation** is behind `ContentGenerator`. The safe template implementation uses supplied product fields only and deliberately avoids unsupported product claims. A production AI adapter should be configured separately.

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

`0000_initial` owns the original `affiliates`, `offers`, `conversions`, and `commissions` tables. `0001_affiliateos_foundation` adds the domain-foundation tables: marketplaces, affiliate accounts, products, affiliate offers, campaigns, campaign offers, tracking links/clicks, social accounts, and content. `0002_tracking_links_campaign_index` supplies the `tracking_links_campaign_idx` index declared by the Drizzle schema but absent from `0001`. Amounts are integer minor units (`*_cents`); commission rates use basis points. Credentials are represented only as `credential_reference` fields—never secret values.

## API

Existing endpoints remain under `/api/v1`: affiliates, offers, conversions, commissions, and health. A product-opportunity score is available at:

```text
POST /api/v1/product-opportunities/score
```

It accepts a product plus optional `commissionRateBps` and `audienceRelevance` (0–1), and returns transparent score reasons. The score is a prioritisation signal, **not a sales forecast or guarantee**. Marketplace data must be acquired through approved provider integrations and persisted before it can be shown as product opportunities.

## Configuration and credentials

## Marketplace integration readiness

Marketplace Connections are configuration records, not a claim that an external marketplace is connected. `POST /api/v1/marketplaces` creates a disabled or unverified record; `POST /api/v1/marketplaces/:connectionSlug/test` is the only operation that can mark a test-capable provider healthy. The API returns `hasCredentialReference`, never the reference itself, and the dashboard never renders it. Mock providers are labelled **tests only** and cannot represent a live connection.

```text
GET    /api/v1/marketplaces/providers
GET    /api/v1/marketplaces
POST   /api/v1/marketplaces
GET    /api/v1/marketplaces/:connectionSlug
PATCH  /api/v1/marketplaces/:connectionSlug
PUT    /api/v1/marketplaces/:connectionSlug/enabled
POST   /api/v1/marketplaces/:connectionSlug/test
GET    /api/v1/marketplaces/:connectionSlug/health
```

To add a future **official** adapter, implement `MarketplaceProvider` in `apps/api/src/domain/`, set `connectionMode: "official_api"`, declare only the capabilities actually supported, validate only non-secret configuration, and implement `testConnection` only when the official API has a safe verification operation. Register the adapter during production service composition in `apps/api/src/server.ts` (or a dedicated provider bootstrap). Supply an opaque secret-manager locator such as `vault://affiliateos/marketplace/acme` in `credentialReference`; have the adapter resolve it at runtime through deployment infrastructure, never from PostgreSQL metadata or the dashboard. Do not register a provider for a marketplace until its official API agreement, scopes, and credential flow have been approved.

Connection `configuration` rejects secret-like fields (`token`, `secret`, `password`, `apiKey`, and similar). Keep region, account identifiers, API version, and other non-sensitive adapter settings there. Failed health checks persist a redacted diagnostic only; API/request logging redacts credential and configuration fields.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (required by API runtime). |
| `API_HOST`, `API_PORT` | API listener settings. |
| `VITE_API_URL` | Dashboard API base URL for development/proxy configuration. |
| `AFFILIATEOS_MARKETPLACE_*_CREDENTIAL_REF` | Optional deployment-level reference to a secret-manager entry; adapters resolve it at runtime. |
| `AFFILIATEOS_SOCIAL_*_CREDENTIAL_REF` | Optional OAuth/API credential reference for an approved social adapter. |
| `AFFILIATEOS_AI_*_CREDENTIAL_REF` | Optional credential reference for a production content-generator adapter. |

Do not put API keys, OAuth tokens, or marketplace credentials in `.env.example`, source code, migrations, or the database metadata JSON. Production adapters must use the official OAuth/API scopes and consent flows of their platforms; AffiliateOS intentionally does not scrape marketplaces, create accounts, or post automatically without authorization.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Tests cover existing affiliate/conversion/commission behavior plus provider registration, product scoring, audience matching, and claim-safe content generation.

## Roadmap

1. Implement approved marketplace adapters once their official credentials and API terms are available.
2. Persist product, campaign, tracking, content, and social-account workflows through the API/dashboard.
3. Add OAuth callback handling and secret-manager integration for approved social adapters.
4. Build database-backed analytics for clicks, conversions, orders, commissions, revenue, CTR, conversion rate, and campaign/product/marketplace/social breakdowns.
