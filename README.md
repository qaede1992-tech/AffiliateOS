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
npm run db:verify                 # check assets, migrate, then inspect PostgreSQL
npm run dev
```

## HTTP runtime hardening

The API accepts an explicit comma-separated `API_CORS_ORIGINS` allowlist. Keep it restricted to the deployed dashboard origins; the default is `http://localhost:5173` for local development. API request bodies are limited to 1 MiB and requests time out after 30 seconds. Responses include baseline browser hardening headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy`).

## Operational workflow

The supported operational path is marketplace catalog persistence → affiliate offer → campaign → tracking link → click → explicit conversion attribution → analytics. Social OAuth remains provider-neutral and stores only opaque credential references until approved external adapters and secret-manager integration are configured.
