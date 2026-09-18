# AffiliateOS

AffiliateOS is a TypeScript SaaS foundation for managing affiliate partnerships, offers, conversions, and commissions.

## Foundation

The repository uses an npm workspace layout:

- `apps/web`: React and Vite frontend.
- `apps/api`: Fastify API with environment validation and centralized error handling.
- `packages/shared`: shared TypeScript domain contracts for affiliates, offers, conversions, commissions, and API health responses.

The current slice uses PostgreSQL persistence through Drizzle ORM. It intentionally contains no authentication, payment processing, integrations, or mock business data.

## Requirements

- Node.js 24+
- npm 11+

## Development

Copy `.env.example` to `.env` when local environment overrides are needed. The defaults work without an environment file.

```bash
npm install
npm run dev
```

The frontend runs on the Vite default port and the API runs on `http://localhost:3001`.

## API resources

All resource endpoints are under `/api/v1` and return `{ "data": [...] }` for list responses.

| Resource | Endpoints | Notes |
| --- | --- | --- |
| Affiliates | `GET /affiliates`, `POST /affiliates` | Created affiliates start active. |
| Offers | `GET /offers`, `POST /offers` | Offers use integer basis points for commission rates; created offers start active. |
| Conversions | `GET /conversions`, `POST /conversions` | Amounts use integer cents and require an existing affiliate and active offer. |
| Commissions | `GET /commissions` | A pending commission is created automatically for each conversion. |

The health endpoint is `GET /api/v1/health`. Validation errors return HTTP 400; missing domain relationships return HTTP 404. Data is lost when the API process stops until a persistence layer is introduced.

## Verification and production build

```bash
npm run typecheck
npm test
npm run build
npm start
```

The API production process serves the compiled API from `apps/api/dist`.