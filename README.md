# Best-Online-Shop

Online shop project — Bulgarian-language e-commerce platform on AWS.

## Repository layout

```
.
├── package.json      npm workspaces root
├── frontend/         Next.js 16 app (Amplify Hosting)
├── backend/
│   ├── db/           Drizzle schema + migrations + seed (@shop/db)
│   └── shop-api/     Hono read API: catalog list + detail (@shop/api)
├── infra/            Terraform IaC (planned)
├── .github/
│   └── workflows/    CI/CD pipelines (planned)
└── docs/
    ├── README.md                     Functional / product specification
    ├── TECHSPEC.md                   AWS infrastructure architecture
    └── AWS_PRICING_RESEARCH_2026.md  Verified rate sheet for cost calculations
```

This is an **npm workspaces** monorepo. One `npm install` at the root
provisions every workspace; cross-package imports (`@shop/db`, `@shop/api`)
are linked automatically.

## Bring it up locally

```bash
# From the repo root, one time:
npm install

# Database (Docker Postgres 17):
npm run db:up
npm run db:migrate
npm run db:seed

# API (Hono on Node, http://localhost:3001):
npm run api:dev

# Frontend (Next.js, http://localhost:3000):
npm run frontend:dev
```

Visit http://localhost:3000/api-demo to see the typed API client in action.

## Documentation

Read the docs in this order:

1. `docs/README.md` — what the shop does (product spec, in Bulgarian)
2. `docs/TECHSPEC.md` — how it's hosted on AWS (English, with Bulgarian sections)
3. `docs/AWS_PRICING_RESEARCH_2026.md` — verified AWS rates underpinning the cost tables

## Status

- Frontend: UI prototype with mock data, lint/typecheck clean. Type-safe Hono RPC client wired in (`/api-demo` page).
- Backend:
  - `@shop/db` — schema + migrations + seed, validated against PGlite.
  - `@shop/api` — Hono read API for catalog (GET /products, GET /products/:slug). OpenAPI 3.1 spec, ETag + s-maxage caching, RFC 9457 problem responses, integration tests.
- Infrastructure: not started.
- Workflows: not started.
