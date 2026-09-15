# AffiliateOS

AffiliateOS is a TypeScript SaaS foundation for managing affiliate partnerships, offers, conversions, and commissions.

## Foundation

The repository uses an npm workspace layout:

- `apps/web`: React and Vite frontend.
- `apps/api`: Fastify API with environment validation and centralized error handling.
- `packages/shared`: shared TypeScript domain contracts for affiliates, offers, conversions, commissions, and API health responses.

The initial foundation intentionally contains no persistence, authentication, payment processing, integrations, or mock business data.

## Requirements

- Node.js 24+
- npm 11+

## Development

Copy `.env.example` to `.env` when local environment overrides are needed. The defaults work without an environment file.

```bash
npm install
npm run dev
```

The frontend runs on the Vite default port and the API runs on `http://localhost:3001`. The API health endpoint is `GET /api/v1/health`.

## Verification and production build

```bash
npm run typecheck
npm run build
npm start
```

The API production process serves the compiled API from `apps/api/dist`.