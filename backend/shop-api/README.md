# @shop/api — the shop API

Hono on Lambda. Same handler runs locally on Node via `@hono/node-server`.

> **Scope note.** This README was written for the original catalog read
> slice and keeps its quick-start + design-rationale role. The API has
> since grown far beyond it — auth (incl. GDPR self-service), cart,
> orders + 14-day withdrawal, address book, consent receipts, CSP
> reporting, **admin auth (TOTP MFA)** and **admin order management**
> (`/admin/orders/*`, 2026-06-10). The authoritative, up-to-date route
> inventory lives in the root `README.md` → "What's wired up"; the
> machine-readable contract is `GET /openapi.json`.

## Quick start

```bash
# from repo root, one-time:
npm install                  # installs all workspaces
npm run db:up                # start Docker Postgres
npm run db:migrate           # apply migrations
npm run db:seed              # populate demo data

# in shop-api:
cd backend/shop-api
cp .env.example .env

# run the API:
npm run dev                  # http://localhost:3001
```

Smoke test:

```bash
curl -s http://localhost:3001/health                       | jq
curl -s http://localhost:3001/products                     | jq '.items | length'
curl -s http://localhost:3001/products/wireless-headphones | jq
curl -s -i http://localhost:3001/products | head -20         # see ETag, Cache-Control
curl -s http://localhost:3001/openapi.json | jq '.info'
```

## Tests

Tests run against a separate `shop_test` database on the same Docker
Postgres. The global setup drops & recreates `shop_test` and applies
migrations once per `vitest run`.

```bash
npm run test
# every test runs after a TRUNCATE — full isolation, no leakage.
```

## Endpoints (original catalog slice — see scope note above for the rest)

- `GET /health` — liveness probe.
- `GET /products` — paginated catalog list. Query params:
  - `categorySlug` — filter to a single category (no recursion yet).
  - `inStock=true` — exclude out-of-stock products.
  - `q` — free-text over name and code (ILIKE).
  - `sort` — `featured` (default), `newest`, `price_asc`, `price_desc`.
  - `limit` — page size, max 60, default 24.
  - `cursor` — opaque cursor from a previous response's `nextCursor`.
- `GET /products/:slug` — single product with all images and category breadcrumb.
- `GET /openapi.json` — auto-generated OpenAPI 3.1 spec.

## Why these design choices

Cursor pagination, not OFFSET. OFFSET drifts under concurrent inserts and is
O(N) per page. Keyset is O(log N) and stable.

`Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=60`.
CloudFront caches for 5 minutes; browsers always revalidate via the ETag handshake;
edge serves stale for up to a minute while it refreshes in the background.

RFC 9457 Problem Details for errors. One consistent error contract across every
endpoint. `Content-Type: application/problem+json` makes the error type
unambiguous to clients and CDNs.

OpenAPI 3.1 generated from typed Zod routes. The schemas are also the
runtime validators — no drift between docs and behaviour.

Typed DTOs for the frontend. `@shop/api` re-exports concrete Zod-inferred
shapes from `src/types.ts` (`ProductsPage`, `AdminOrderDetail`, …) that the
frontend's plain-`fetch` clients annotate with. (The earlier `hc<AppType>`
Hono-RPC approach was abandoned — it collapses to `unknown` under
`next build`; see the root README "Browsing the API".)

Drizzle, not Prisma. ~45 ms cold start vs ~320 ms; 7 KB driver vs 1.6 MB.
On Lambda this is the difference between a snappy first request and
"is the website broken?".
