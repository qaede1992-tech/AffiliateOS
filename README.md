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
docker compose up -d postgres
npm install
npm run db:migrate
npm run dev
```

The web app uses Vite's default port; the API listens on `http://localhost:3001`. The production API uses PostgreSQL. Tests inject in-memory repositories, so they do not require a database.

## Database and migrations

Drizzle schema lives at `apps/api/src/db/schema.ts`; SQL history is `apps/api/drizzle/`.

```bash
npm run db:generate  # generate a candidate migration after schema changes
npm run db:migrate   # apply tracked migrations
```

`0000_initial` owns the original `affiliates`, `offers`, `conversions`, and `commissions` tables. `0001_affiliateos_foundation` is additive and uses `IF NOT EXISTS` for new tables/indexes, so it does not duplicate the initial table creation or drop existing data. It adds marketplaces, affiliate accounts, products, affiliate offers, campaigns, tracking links/clicks, social accounts, and content. Amounts are integer minor units (`*_cents`); commission rates use basis points. Credentials are represented only as `credential_reference` fields—never secret values.

## API

Existing endpoints remain under `/api/v1`: affiliates, offers, conversions, commissions, and health. A product-opportunity score is available at:

```text
POST /api/v1/product-opportunities/score
```

It accepts a product plus optional `commissionRateBps` and `audienceRelevance` (0–1), and returns transparent score reasons. The score is a prioritisation signal, **not a sales forecast or guarantee**. Marketplace data must be acquired through approved provider integrations and persisted before it can be shown as product opportunities.

## Configuration and credentials

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
